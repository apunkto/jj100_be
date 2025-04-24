import { Hono } from 'hono'
import { getSupabaseClient } from './supabase'
import { cors } from 'hono/cors'

type Env = {
    SUPABASE_URL: string
    SUPABASE_SERVICE_ROLE_KEY: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
    origin: '*', // or restrict to your frontend URL: 'http://localhost:3000'
    allowMethods: ['GET', 'POST', 'OPTIONS'],
}))

app.get('/ctp/:hole', async (c) => {
    const supabase = getSupabaseClient(c.env)
    const hole = Number(c.req.param('hole'))
    console.log( `Fetching CTP for hole ${hole}`)
    const { data, error } = await supabase
        .from('ctp_results')
        .select('*')
        .eq('hole', hole)
        .order('distance_cm', { ascending: true })
        .limit(1)
    console.log( `Fetched CTP for hole ${hole}`, data, error)
    return c.json(data?.[0] ?? {})
})


app.post('/ctp/:hole', async (c) => {
    const supabase = getSupabaseClient(c.env)
    const hole = Number(c.req.param('hole'))
    const { player_name, distance_cm } = await c.req.json()

    const { data, error } = await supabase
        .from('ctp_results')
        .insert([{ hole, player_name, distance_cm }])

    return c.json({ success: !error, data, error })
})

export default app
