import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {getConfigValue} from './service'
import {getUserCompetitions} from '../player/service'
import {getSupabaseClient} from '../shared/supabase'

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

    const supabase = getSupabaseClient(c.env)
    
    // For admins: verify competition exists in database
    // For regular users: verify competition is in their available list
    if (user.isAdmin) {
        const { data, error: checkError } = await supabase
            .from('metrix_competition')
            .select('id')
            .eq('id', competitionId)
            .maybeSingle()
        if (checkError) {
            return c.json({ success: false, error: checkError.message }, 500)
        }
        if (!data) {
            return c.json({ success: false, error: 'Competition not found' }, 404)
        }
    } else {
        const list = await getUserCompetitions(c.env, user.metrixUserId)
        if (!list.some((x) => x.id === competitionId)) {
            return c.json({ success: false, error: 'Competition not available for this user' }, 403)
        }
    }

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
