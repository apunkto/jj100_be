import {Hono} from 'hono'
import {getSupabaseClient} from './supabase'
import {cors} from 'hono/cors'
import {getCtpLeader, submitCtpResult} from './service/ctpService'
import {getPlayers} from './service/playerService'
import type {CtpResultDTO} from './dto/CtpResultDTO'
import {checkInPlayer} from "./service/checkinService";

export type Env = {
    SUPABASE_URL: string
    SUPABASE_SERVICE_ROLE_KEY: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
}))

app.get('/ctp/:hole', async (c) => {
    const hole = Number(c.req.param('hole'))

    const { data, error } = await getCtpLeader(c.env, hole)
    if (error) return c.json({ error }, 500)

    const dto: CtpResultDTO | null = data
        ? {
            hole: data.hole,
            distance_cm: data.distance_cm,
            player_id: data.player_id,
            player_name: data.player?.name ?? 'Unknown',
        }
        : null

    return c.json(dto) // ✅ returns either the DTO or null
})


app.post('/ctp/:hole', async (c) => {
    const hole = Number(c.req.param('hole'))
    const {player_id, distance_cm} = await c.req.json()

    const {data, error} = await submitCtpResult(c.env, hole, player_id, distance_cm)

    return c.json({success: !error, data, error})
})

app.get('/players', async (c) => {
    const {data, error} = await getPlayers(c.env)

    return c.json({success: !error, data, error})
})

app.post('/lottery/checkin', async (c) => {
    const { player_id } = await c.req.json()
    if (!player_id) {
        return c.json({ error: 'Missing player_id' }, 400)
    }

    try {
        await checkInPlayer(c.env, Number(player_id))
        return c.json({ success: true })
    } catch (err: any) {
        if (err.status === 409) {
            return c.json({ error: 'Player already checked in' }, 409)
        }
        return c.json({ error: err.message || 'Internal Server Error' }, 500)
    }
})

export default app
