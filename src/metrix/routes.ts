import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {fetchMetrixIdentityByEmail, getCurrentHole} from './service'
import {getCompetitionStats, getMetrixPlayerStats, getTopPlayersByDivision} from './statsService'
import {getUserCompetitions} from '../player/service'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.get('/competition/:id/top-players-by-division', async (c) => {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const user = c.get('user')
    const list = await getUserCompetitions(c.env, user.metrixUserId)
    if (!list.some((x) => x.id === competitionId)) {
        return c.json({ success: false, error: 'Competition not available for this user' }, 403)
    }

    const { data, error } = await getTopPlayersByDivision(c.env, competitionId)
    if (error) return c.json({ success: false, error }, 500)
    return c.json({ success: true, data: data ?? { topPlayersByDivision: {} } })
})

router.get('/competition/:id/stats', async (c) => {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const user = c.get('user')
    const list = await getUserCompetitions(c.env, user.metrixUserId)
    if (!list.some((x) => x.id === competitionId)) {
        return c.json({ success: false, error: 'Competition not available for this user' }, 403)
    }

    const { data, error } = await getCompetitionStats(c.env, competitionId)
    if (error) return c.json({ success: false, error }, 500)
    return c.json({ success: true, data: data ?? { playerCount: 0, mostHolesLeft: 0, finishedPlayersCount: 0, totalThrows: 0, averageDiff: 0, lakeOBCount: 0, lakePlayersCount: 0, totalHoles: 0, longestStreaks: [], longestAces: [] } })
})

router.post('/check-email', async (c) => {
    const body = await c.req.json<{ email?: string }>()
    const email = (body.email ?? '').trim().toLowerCase()

    if (!email || !email.includes('@')) {
        return c.json({success: false, error: 'Invalid email'}, 400)
    }

    const identities = await fetchMetrixIdentityByEmail(email)
    const metrixUserId = identities.length === 1 ? identities[0].userId : null
    return c.json({success: true, data: {metrixUserId, identities}})
})

router.get('/player/stats', async (c) => {
    const user = c.get('user')
    const userId = String(user.metrixUserId)
    if (!userId) return c.json({ error: 'Invalid userId' }, 400)
    if (user.activeCompetitionId == null) return c.json({ error: 'No active competition' }, 400)

    const { data, error } = await getMetrixPlayerStats(c.env, userId, user.activeCompetitionId)
    if (error) return c.json({ error }, 404)
    return c.json({ success: true, data })
})

router.get('/player/current-hole', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null) return c.json({ error: 'No active competition' }, 400)

    const { data, error } = await getCurrentHole(c.env, user.metrixUserId, user.activeCompetitionId)
    if (error) return c.json({ error }, 404)
    return c.json({ success: true, data: { currentHole: data } })
})

export default router
