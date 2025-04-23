import { Hono } from 'hono'
import { getSupabaseClient } from '../../lib/supabaseClient'

type Env = {
    SUPABASE_URL: string
    SUPABASE_ANON_KEY: string
}

const app = new Hono<{ Bindings: Env }>()

app.get('/:hole', async (c) => {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = c.env
    const supabase = getSupabaseClient({ SUPABASE_URL, SUPABASE_ANON_KEY })

    const hole = Number(c.req.param('hole'))

    const { data, error } = await supabase
        .from('ctp_results')
        .select('*')
        .eq('hole', hole)
        .order('distance_cm', { ascending: true })
        .limit(1)

    if (error) return c.json({ error }, 500)
    return c.json(data?.[0] || {})
})

app.post('/:hole', async (c) => {
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = c.env
    const supabase = getSupabaseClient({ SUPABASE_URL, SUPABASE_ANON_KEY })

    const hole = Number(c.req.param('hole'))
    const body = await c.req.json()
    const { player_name, distance_cm } = body

    const { data, error } = await supabase
        .from('ctp_results')
        .insert([{ hole, player_name, distance_cm }])

    if (error) return c.json({ error }, 500)
    return c.json(data)
})

export const onRequest = app.fetch
