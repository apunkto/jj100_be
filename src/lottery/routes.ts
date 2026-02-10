import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {
    checkInPlayer,
    confirmFinalGamePlayer,
    deleteCheckinPlayer,
    drawRandomWinner,
    type FinalGameParticipant,
    getCheckedInPlayers,
    getEligibleFinalGameCount,
    getFinalGameParticipants,
    getMyCheckin,
    removeFinalGameParticipant
} from './service'
import {getDrawState, getEligibleDrawCount, setDrawState} from './drawState'
import {getFinalGameDrawState, getFinalGamePuttingPayload, setFinalGameDrawState,} from './finalGameDrawState'
import {
    getPuttingGameState,
    PuttingGameState,
    recordPuttingResult,
    resetPuttingGame,
    startPuttingGame,
} from './puttingGame'
import {base64EncodeUtf8} from './base64'
import {requireAdmin} from '../middleware/admin'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.post('/checkin', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    try {
        await checkInPlayer(c.env, user.playerId, user.metrixUserId, user.activeCompetitionId)
        return c.json({success: true})
    } catch (err: unknown) {
        const e = err as { status?: number; code?: string; message?: string }
        if (e.status === 409) {
            return c.json({error: 'Player already checked in'}, 409)
        }
        if (e.code === 'not_competition_participant') {
            return c.json({error: e.message ?? 'Not a competition participant', code: e.code}, 403)
        }
        return c.json({error: e.message ?? 'Internal Server Error'}, 500)
    }
})

router.get("/checkin/me", async (c) => {
    const user = c.get("user")
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const {data, error} = await getMyCheckin(c.env, user.playerId, user.activeCompetitionId)

    if (error) {
        return c.json({success: false, data: null, error}, 500)
    }

    // if not checked in, data will be null
    return c.json({
        success: true,
        data: {checkedIn: Boolean(data)},
        error: null,
    })
})

router.delete("/checkin/me", async (c) => {
    const user = c.get("user")
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const {data, error} = await getMyCheckin(c.env, user.playerId, user.activeCompetitionId)

    if (error) {
        return c.json({success: false, error: 'Failed to retrieve check-in'}, 500)
    }

    if (!data) {
        return c.json({success: false, error: 'Player is not checked in'}, 400)
    }

    const deleteResult = await deleteCheckinPlayer(c.env, data.id)

    if (deleteResult.error) {
        return c.json({success: false, error: 'Failed to delete check-in'}, 500)
    }

    return c.json({success: true})
})

router.use('/checkins', requireAdmin)
router.get('/checkins', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const {data, error} = await getCheckedInPlayers(c.env, user.activeCompetitionId)

    if (error) {
        return c.json({error}, 500)
    }

    return c.json({success: true, data})
})

router.use('/draw', requireAdmin)
router.post('/draw', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const finalGame = c.req.query('final_game') === 'true'
    const competitionId = user.activeCompetitionId

    const {data, participantNames, error} = await drawRandomWinner(c.env, competitionId, finalGame)

    if (error) {
        return c.json({error}, 400)
    }

    const winnerName = data!.player.name

    if (finalGame) {
        const participantCount = await getEligibleFinalGameCount(c.env, competitionId)
        await setFinalGameDrawState(c.env, competitionId, {
            participantCount,
            winnerName,
            participantNames: participantNames ?? [],
        })
        const payload = await getFinalGameDrawState(c.env, competitionId)
        const doStub = c.env.FINAL_GAME_DRAW_DO.get(
            c.env.FINAL_GAME_DRAW_DO.idFromName(`final-game-draw-${competitionId}`)
        )

        c.executionCtx.waitUntil(
            doStub.fetch('https://do/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).catch((err) => console.error('[lottery/draw] final-game-draw broadcast failed:', err))
        )
    } else {
        const countdownStartedAt = Date.now()
        const participantCount = await getEligibleDrawCount(c.env, competitionId)
        await setDrawState(c.env, competitionId, {
            participantCount,
            countdownStartedAt,
            winnerName,
            participantNames: participantNames ?? [],
        })
        const doStub = c.env.DRAW_DASHBOARD_DO.get(
            c.env.DRAW_DASHBOARD_DO.idFromName(`draw-${competitionId}`)
        )

        const msg = {
            participantCount,
            countdownStartedAt,
            winnerName,
            participantNames: participantNames ?? [],
        }

        c.executionCtx.waitUntil(
            doStub.fetch('https://do/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(msg),
            }).catch((err) => console.error('[lottery/draw] broadcast to dashboard failed:', err))
        )
    }

    return c.json(data)
})

const INITIAL_DRAW_STATE_HEADER = 'X-Initial-Draw-State'

router.use('/draw-state', requireAdmin)
router.get('/draw-state', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    const state = await getDrawState(c.env, user.activeCompetitionId)
    return c.json(state)
})

router.use('/draw-sse', requireAdmin)
router.get('/draw-sse', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const competitionId = user.activeCompetitionId
    const state = await getDrawState(c.env, competitionId)
    const headers = new Headers(c.req.raw.headers)
    headers.set(INITIAL_DRAW_STATE_HEADER, base64EncodeUtf8(JSON.stringify(state)))
    headers.set('X-Competition-Id', competitionId.toString())
    const doRequest = new Request(c.req.raw.url, {method: 'GET', headers})

    const doStub = c.env.DRAW_DASHBOARD_DO.get(c.env.DRAW_DASHBOARD_DO.idFromName(`draw-${competitionId}`))
    let doRes: Response
    try {
        doRes = (await doStub.fetch(doRequest as any)) as unknown as Response
    } catch (err) {
        throw err
    }
    if (!doRes.ok || !doRes.body) {
        return doRes
    }
    const {readable, writable} = new TransformStream()
    void doRes.body.pipeTo(writable)
    return new Response(readable, {
        status: 200,
        statusText: 'OK',
        headers: {
            ...Object.fromEntries(doRes.headers.entries()),
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    })
})

const INITIAL_FINAL_GAME_DRAW_STATE_HEADER = 'X-Initial-Final-Game-Draw-State'
const INITIAL_FINAL_GAME_PUTTING_STATE_HEADER = 'X-Initial-Final-Game-Putting-State'

router.use('/final-game-draw-state', requireAdmin)
router.get('/final-game-draw-state', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    const state = await getFinalGameDrawState(c.env, user.activeCompetitionId)
    return c.json(state)
})

router.use('/final-game-draw-sse', requireAdmin)
router.get('/final-game-draw-sse', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const competitionId = user.activeCompetitionId
    const state = await getFinalGameDrawState(c.env, competitionId)
    const headers = new Headers(c.req.raw.headers)
    headers.set(INITIAL_FINAL_GAME_DRAW_STATE_HEADER, base64EncodeUtf8(JSON.stringify(state)))
    headers.set('X-Competition-Id', competitionId.toString())
    const doRequest = new Request(c.req.raw.url, {method: 'GET', headers})

    const doStub = c.env.FINAL_GAME_DRAW_DO.get(c.env.FINAL_GAME_DRAW_DO.idFromName(`final-game-draw-${competitionId}`))
    const doRes = (await doStub.fetch(doRequest as any)) as unknown as Response
    if (!doRes.ok || !doRes.body) return doRes

    const {readable, writable} = new TransformStream()
    void doRes.body.pipeTo(writable)
    return new Response(readable, {
        status: 200,
        statusText: 'OK',
        headers: {
            ...Object.fromEntries(doRes.headers.entries()),
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    })
})

router.use('/final-game-putting-state', requireAdmin)
router.get('/final-game-putting-state', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    const {data: participants} = await getFinalGameParticipants(c.env, user.activeCompetitionId)
    if (!participants || participants.length !== 10) {
        return c.json({error: 'Exactly 10 participants required'}, 400)
    }
    const state = await getFinalGamePuttingPayload(c.env, user.activeCompetitionId, participants)
    return c.json(state ?? {
        puttingGame: {
            gameStatus: 'not_started',
            currentLevel: 1,
            currentTurnParticipantId: null,
            currentTurnName: null,
            winnerName: null,
            players: []
        }
    })
})

router.use('/final-game-putting-sse', requireAdmin)
router.get('/final-game-putting-sse', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const competitionId = user.activeCompetitionId
    console.log('[lottery] final-game-putting-sse: opening stream for competitionId=', competitionId)
    const {data: participants} = await getFinalGameParticipants(c.env, user.activeCompetitionId)
    if (!participants || participants.length !== 10) {
        return c.json({error: 'Exactly 10 participants required'}, 400)
    }
    const state = await getFinalGamePuttingPayload(c.env, competitionId, participants)
    const payload = state ?? {
        gameStatus: 'not_started',
        currentLevel: 1,
        currentTurnParticipantId: null,
        currentTurnName: null,
        winnerName: null,
        players: []
    }
    const headers = new Headers(c.req.raw.headers)
    headers.set(INITIAL_FINAL_GAME_PUTTING_STATE_HEADER, base64EncodeUtf8(JSON.stringify(payload)))
    console.log("set header", INITIAL_FINAL_GAME_PUTTING_STATE_HEADER, "with payload", payload)
    headers.set('X-Competition-Id', competitionId.toString())
    const doRequest = new Request(c.req.raw.url, {method: 'GET', headers})

    const doName = `final-game-putting-${competitionId}`
    const doStub = c.env.FINAL_GAME_PUTTING_DO.get(c.env.FINAL_GAME_PUTTING_DO.idFromName(doName))
    const doRes = (await doStub.fetch(doRequest as any)) as unknown as Response
    console.log('[lottery] final-game-putting-sse: DO', doName, 'responded', doRes.status, '— client SSE stream attached')
    if (!doRes.ok || !doRes.body) return doRes

    const {readable, writable} = new TransformStream()
    void doRes.body.pipeTo(writable)
    return new Response(readable, {
        status: 200,
        statusText: 'OK',
        headers: {
            ...Object.fromEntries(doRes.headers.entries()),
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    })
})

router.use('/draw-reset', requireAdmin)
router.post('/draw-reset', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const competitionId = user.activeCompetitionId
    const participantCount = await getEligibleDrawCount(c.env, competitionId)

    await setDrawState(c.env, competitionId, {participantCount})

    const doStub = c.env.DRAW_DASHBOARD_DO.get(c.env.DRAW_DASHBOARD_DO.idFromName(`draw-${competitionId}`))
    void doStub
        .fetch(
            new Request('http://do/broadcast', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({participantCount}),
            }) as any
        )
        .catch((err) => console.error('[lottery/draw-reset] broadcast to dashboard failed:', err))

    return c.json({success: true})
})


router.use('/final-game', requireAdmin)
router.get('/final-game/participants', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    const {data, error} = await getFinalGameParticipants(c.env, user.activeCompetitionId)
    if (error) return c.json({error}, 500)
    return c.json({data: data ?? []})
})

router.post('/final-game/game/start', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    const {data: participants} = await getFinalGameParticipants(c.env, user.activeCompetitionId)
    if (!participants || participants.length !== 10) {
        return c.json({error: 'Exactly 10 participants required'}, 400)
    }

    const {error} = await startPuttingGame(c.env, user.activeCompetitionId, participants)
    if (error) return c.json({error}, 400)
    c.executionCtx.waitUntil(
        broadcastFinalGamePuttingState(c.env, user.activeCompetitionId, participants)
    )
    return c.json({success: true})
})

router.post('/final-game/game/reset', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    const {data: participants} = await getFinalGameParticipants(c.env, user.activeCompetitionId)
    if (!participants || participants.length !== 10) {
        return c.json({error: 'Exactly 10 participants required'}, 400)
    }
    const {error} = await resetPuttingGame(c.env, user.activeCompetitionId, participants)
    if (error) return c.json({error}, 400)
    c.executionCtx.waitUntil(
        broadcastFinalGamePuttingState(c.env, user.activeCompetitionId, participants)
    )
    return c.json({success: true})
})

router.post('/final-game/game/attempt', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    let body: { participantId?: number; result?: string }
    try {
        body = await c.req.json()
    } catch {
        return c.json({error: 'Invalid body'}, 400)
    }
    const participantId = typeof body.participantId === 'number' ? body.participantId : null
    const result = body.result === 'in' || body.result === 'out' ? body.result : null
    if (participantId == null || !result) return c.json({error: 'participantId and result (in|out) required'}, 400)
    const {data: participants} = await getFinalGameParticipants(c.env, user.activeCompetitionId)
    if (!participants || participants.length !== 10) {
        return c.json({error: 'Exactly 10 participants required'}, 400)
    }
    const {
        error,
        payload
    } = await recordPuttingResult(c.env, user.activeCompetitionId, participantId, result, participants)
    if (error) return c.json({error}, 400)
    c.executionCtx.waitUntil(
        broadcastFinalGamePuttingState(
            c.env,
            user.activeCompetitionId,
            participants,
            payload // payloadOverride
        )
    )
    return c.json(payload)
})

router.get('/final-game/game/state', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const {data, error: partErr} = await getFinalGameParticipants(c.env, user.activeCompetitionId)
    if (partErr || !data) {
        return c.json(
            {
                state: null,
                error: (partErr as { message?: string } | null)?.message ?? 'No participants',
            },
            500
        )
    }
    const participants = data

    const {state, error} = await getPuttingGameState(c.env, user.activeCompetitionId, {participants})
    if (error) return c.json({error}, 500)
    return c.json(state)
})

async function broadcastFinalGameDrawState(env: Env, competitionId: number): Promise<void> {
    const payload = await getFinalGameDrawState(env, competitionId)
    const doStub = env.FINAL_GAME_DRAW_DO.get(env.FINAL_GAME_DRAW_DO.idFromName(`final-game-draw-${competitionId}`))
    void doStub
        .fetch(
            new Request('http://do/broadcast', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload),
            }) as any
        )
        .catch((err) => console.error('[lottery] final-game-draw broadcast failed:', err))
}

async function broadcastFinalGamePuttingState(
    env: Env,
    competitionId: number,
    participants: FinalGameParticipant[],
    payloadOverride?: PuttingGameState | null
): Promise<void> {
    const payload = payloadOverride ?? (await getFinalGamePuttingPayload(env, competitionId, participants))
    if (!payload) {
        console.log('[lottery] broadcastFinalGamePuttingState: no payload for competitionId=', competitionId)
        return
    }
    const doName = `final-game-putting-${competitionId}`
    console.log('[lottery] broadcastFinalGamePuttingState: sending to DO', doName, 'gameStatus=', payload)
    const doStub = env.FINAL_GAME_PUTTING_DO.get(env.FINAL_GAME_PUTTING_DO.idFromName(doName))
    try {
        const res = await doStub.fetch('https://do/broadcast', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload),
        })
        const text = await (res as { text(): Promise<string>; status: number }).text()
        const status = (res as { status: number }).status
        let parsed: { success?: boolean; streamsWritten?: number } = {}
        try {
            parsed = JSON.parse(text) as { success?: boolean; streamsWritten?: number }
        } catch {
            // ignore
        }
        console.log('[lottery] broadcastFinalGamePuttingState: DO responded', status, 'for', doName, 'streamsWritten=', parsed.streamsWritten ?? '?', parsed.success === true ? 'ok' : 'body=' + text.slice(0, 120))
    } catch (err) {
        console.error('[lottery] final-game-putting broadcast failed:', err)
    }
}

router.delete('/final-game/:id', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    const id = Number(c.req.param('id'))
    if (isNaN(id)) return c.json({error: 'Invalid id'}, 400)
    const {error} = await removeFinalGameParticipant(c.env, id, user.activeCompetitionId)
    if (error) return c.json({error: error.message}, 500)
    await broadcastFinalGameDrawState(c.env, user.activeCompetitionId)
    return c.json({success: true})
})

router.use('/checkin/final', requireAdmin)
router.post('/checkin/final/:checkinId', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const checkinId = Number(c.req.param('checkinId'))
    const competitionId = user.activeCompetitionId

    const {error} = await confirmFinalGamePlayer(c.env, checkinId, competitionId)

    if (error) {
        return c.json({error: error.message}, 500)
    }

    await broadcastFinalGameDrawState(c.env, competitionId)
    return c.json({success: true})
})


router.use('/checkin', requireAdmin)
router.delete('/checkin/:checkinId', async (c) => {
    const checkinId = Number(c.req.param('checkinId'))

    const {error} = await deleteCheckinPlayer(c.env, checkinId)

    if (error) {
        return c.json({error: error.message}, 500)
    }

    return c.json({success: true})
})

export default router
