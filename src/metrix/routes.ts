import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {fetchMetrixIdentityByEmail, getCurrentHole} from './service'
import {getMetrixPlayerStats} from './statsService'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

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
