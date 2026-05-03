import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {requireAdmin} from '../middleware/admin'
import {getLedScreenState, type LedScreenStateValue, setLedScreenState} from './ledScreenState'
import {base64EncodeUtf8} from '../lottery/base64'
import {ledScreenSelectSchema, parseJsonBody} from '../shared/validation'

const INITIAL_LED_STATE_HEADER = 'X-Initial-Led-Screen-State'

type HonoVars = {user: PlayerIdentity}
const router = new Hono<{Bindings: Env; Variables: HonoVars}>()

router.use('*', requireAdmin)

router.get('/state', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)
    const state = await getLedScreenState(c.env, user.activeCompetitionId)
    return c.json(state)
})

router.get('/sse', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const competitionId = user.activeCompetitionId
    const state = await getLedScreenState(c.env, competitionId)
    const headers = new Headers(c.req.raw.headers)
    headers.set(INITIAL_LED_STATE_HEADER, base64EncodeUtf8(JSON.stringify(state)))
    headers.set('X-Competition-Id', competitionId.toString())
    const doRequest = new Request(c.req.raw.url, {method: 'GET', headers})

    const doStub = c.env.LED_SCREEN_CONTROL_DO.get(c.env.LED_SCREEN_CONTROL_DO.idFromName(`led-screen-${competitionId}`))
    const doRes = (await doStub.fetch(doRequest as never)) as unknown as Response
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

router.post('/select', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({error: 'No active competition'}, 400)

    const parsed = await parseJsonBody(() => c.req.json(), ledScreenSelectSchema)
    if (!parsed.success) return c.json({error: parsed.error}, 400)

    const competitionId = user.activeCompetitionId
    const current = await getLedScreenState(c.env, competitionId)

    let leaderboardDivision: string | null = current.leaderboardDivision ?? null
    let leaderboardPanel = current.leaderboardPanel ?? 'division'

    if (parsed.data.leaderboardDivision !== undefined) {
        leaderboardDivision = parsed.data.leaderboardDivision
        if (leaderboardDivision !== null && leaderboardDivision !== '') {
            leaderboardPanel = 'division'
        }
    }
    if (parsed.data.leaderboardPanel !== undefined) {
        leaderboardPanel = parsed.data.leaderboardPanel
    }

    const next: LedScreenStateValue = {
        board: parsed.data.board,
        leaderboardDivision,
        leaderboardPanel,
    }

    await setLedScreenState(c.env, competitionId, next)

    const doStub = c.env.LED_SCREEN_CONTROL_DO.get(c.env.LED_SCREEN_CONTROL_DO.idFromName(`led-screen-${competitionId}`))
    c.executionCtx.waitUntil(
        doStub
            .fetch('https://do/broadcast', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(next),
            })
            .catch((err) => console.error('[admin/led-screen/select] broadcast failed:', err))
    )

    return c.json({success: true, data: next})
})

export default router
