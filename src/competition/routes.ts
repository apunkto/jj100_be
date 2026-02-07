import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {getConfigValue} from './service'
import {getSupabaseClient} from '../shared/supabase'
import {verifyCompetitionAccess} from '../shared/competitionAccess'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

// Config by key: GET /config/:key
router.get('/config/:key', async (c) => {
    const { key } = c.req.param()
    const result = await getConfigValue(c.env, key)
    if (result.error) {
        return c.json({ error: result.error }, 404)
    }
    return c.json({ value: result.data })
})

// Competition by id: GET /competition/:id
router.get('/competition/:id', async (c) => {
    const user = c.get('user')
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        return c.json(
            { success: false, error: accessCheck.error },
            accessCheck.status as 400 | 403 | 404 | 500
        )
    }

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .select('id, name, ctp_enabled, checkin_enabled, prediction_enabled')
        .eq('id', competitionId)
        .maybeSingle()

    if (error) return c.json({ success: false, error: error.message }, 500)
    if (!data) return c.json({ success: false, error: 'Competition not found' }, 404)

    return c.json({ success: true, data }, 200, {
        'Cache-Control': 'private, max-age=300, must-revalidate',
    })
})

export default router
