import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {
    checkInPlayer,
    confirmFinalGamePlayer,
    deleteCheckinPlayer,
    drawRandomWinner,
    getCheckedInPlayers,
    getMyCheckin
} from './service'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.post('/checkin', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({ error: 'No active competition' }, 400)

    try {
        await checkInPlayer(c.env, user.playerId, user.metrixUserId, user.activeCompetitionId)
        return c.json({success: true})
    } catch (err: any) {
        if (err.status === 409) {
            return c.json({error: 'Player already checked in'}, 409)
        }
        if (err.code === 'not_competition_participant') {
            return c.json({error: err.message, code: err.code}, 403)
        }
        return c.json({error: err.message || 'Internal Server Error'}, 500)
    }
})

router.get("/checkin/me", async (c) => {
    const user = c.get("user")
    if (user.activeCompetitionId == null) return c.json({ error: 'No active competition' }, 400)

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
    if (user.activeCompetitionId == null) return c.json({ error: 'No active competition' }, 400)

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

router.get('/checkins', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({ error: 'No active competition' }, 400)

    const {data, error} = await getCheckedInPlayers(c.env, user.activeCompetitionId)

    if (error) {
        return c.json({error}, 500)
    }

    return c.json({success: true, data})
})

router.post('/draw', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({ error: 'No active competition' }, 400)

    const finalGame = c.req.query('final_game') === 'true'

    const {data, error} = await drawRandomWinner(c.env, user.activeCompetitionId, finalGame)

    if (error) {
        return c.json({error}, 400)
    }

    return c.json(data)
})

router.post('/checkin/final/:checkinId', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({ error: 'No active competition' }, 400)

    const checkinId = Number(c.req.param('checkinId'))

    const {error} = await confirmFinalGamePlayer(c.env, checkinId, user.activeCompetitionId)

    if (error) {
        return c.json({error: error.message}, 500)
    }

    return c.json({success: true})
})

router.delete('/checkin/:checkinId', async (c) => {
    const checkinId = Number(c.req.param('checkinId'))

    const {error} = await deleteCheckinPlayer(c.env, checkinId)

    if (error) {
        return c.json({error: error.message}, 500)
    }

    return c.json({success: true})
})

export default router
