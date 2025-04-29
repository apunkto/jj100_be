import {Hono} from 'hono'
import {getSupabaseClient} from './supabase'
import {cors} from 'hono/cors'
import {getCtpHoles, getHoleByNumber, submitCtpResult} from './service/ctpService'
import {getPlayers} from './service/playerService'
import type {CtpResultDTO} from './dto/CtpResultDTO'
import {
    checkInPlayer,
    confirmFinalGamePlayer,
    deleteCheckinPlayer,
    drawRandomWinner,
    getCheckedInPlayers
} from "./service/checkinService";
import {getConfigValue} from "./service/configService";

export type Env = {
    SUPABASE_URL: string
    SUPABASE_SERVICE_ROLE_KEY: string
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
}))

app.get('/hole/:number', async (c) => {
    const holeNumber = Number(c.req.param('number'))
    const {data, error} = await getHoleByNumber(c.env, holeNumber)

    if (error) {
        return c.json({error}, 400)
    }

    return c.json(data)
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
    const {player_id} = await c.req.json()
    if (!player_id) {
        return c.json({error: 'Missing player_id'}, 400)
    }

    try {
        await checkInPlayer(c.env, Number(player_id))
        return c.json({success: true})
    } catch (err: any) {
        if (err.status === 409) {
            return c.json({error: 'Player already checked in'}, 409)
        }
        return c.json({error: err.message || 'Internal Server Error'}, 500)
    }
})


app.get('/holes/ctp', async (c) => {
    const {data, error} = await getCtpHoles(c.env);

    if (error) {
        return c.json({error}, 500);
    }

    return c.json(data ?? []);
});

app.get('/config/:key', async (c) => {
    const {key} = c.req.param()
    const result = await getConfigValue(c.env, key)

    if (result.error) {
        return c.json({error: result.error}, 404)
    }

    return c.json({value: result.data})
})

app.get('/lottery/checkins', async (c) => {
    const {data, error} = await getCheckedInPlayers(c.env)

    if (error) {
        return c.json({error}, 500)
    }

    return c.json({success: true, data})
})

app.post('/lottery/draw', async (c) => {
    const finalGame = c.req.query('final_game') === 'true'

    const {data, error} = await drawRandomWinner(c.env, finalGame)

    if (error) {
        return c.json({error}, 400)
    }

     return c.json(data)
})
app.post('/lottery/checkin/final/:checkinId', async (c) => {
    const checkinId = Number(c.req.param('checkinId'))

    const {error} = await confirmFinalGamePlayer(c.env, checkinId)

    if (error) {
        return c.json({error: error.message}, 500)
    }

    return c.json({success: true})
})

// Delete player
app.delete('/lottery/checkin/:checkinId', async (c) => {
    const checkinId = Number(c.req.param('checkinId'))

    const {error} = await deleteCheckinPlayer(c.env, checkinId)

    if (error) {
        return c.json({error: error.message}, 500)
    }

    return c.json({success: true})
})
export default app
