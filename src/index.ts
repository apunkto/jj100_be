import {Hono} from 'hono'
import {cors} from 'hono/cors'
import {getCtpHoles, getHoleByNumber, getHoles, getTopRankedHoles, submitCtpResult} from './service/ctpService'
import {getPlayers, PlayerIdentity, resolvePlayerIdentity} from './service/playerService'
import {
    checkInPlayer,
    confirmFinalGamePlayer,
    deleteCheckinPlayer,
    drawRandomWinner,
    getCheckedInPlayers,
    getMyCheckin
} from "./service/checkinService";
import {getConfigValue} from "./service/configService";
import {submitFeedback} from "./service/feedbackService";
import type {ExecutionContext, ScheduledEvent} from '@cloudflare/workers-types';
import {fetchMetrixIdentityByEmail, updateHoleStatsFromMetrix} from "./service/metrixService";
import {getMetrixPlayers, getMetrixPlayerStats} from "./service/metrixStatsService";
import {verifySupabaseJwt} from "./service/authService";

const PUBLIC_PATHS = [
    /^\/metrix\/check-email$/,
]

export type Env = {
    SUPABASE_URL: string
    SUPABASE_SERVICE_ROLE_KEY: string
    CURRENT_COMPETITION_ID: number
}

type HonoVars = { user: PlayerIdentity }
const app = new Hono<{ Bindings: Env; Variables: HonoVars }>()

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
}))

app.use('*', async (c, next) => {
    // CORS preflight must pass
    if (c.req.method === 'OPTIONS') return next()

    // Public endpoints
    if (PUBLIC_PATHS.some((re) => re.test(c.req.path))) return next()

    // Everything else requires auth
    try {
        const {email} = await verifySupabaseJwt(c.env, c.req.header('Authorization'))
        const identity = await resolvePlayerIdentity(c.env, email)
        c.set('user', identity)
        return next()
    } catch (err) {
        console.error('Auth error:', err)
        return c.json({error: 'Unauthorized'}, 401)
    }
})

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
    const {distance_cm} = await c.req.json()
    const user = c.get('user')

    const {data, error} = await submitCtpResult(c.env, hole, user.playerId, distance_cm)

    if (error) {
        const status =
            error.code === "ctp_already_submitted" ? 409 :
                error.code === "ctp_too_far" ? 422 :
                    error.code === "not_ctp_hole" ? 400 :
                        error.code === "hole_not_found" ? 404 :
                            error.code === "ctp_disabled" ? 403 :
                                400

        return c.json({success: false, data: null, error}, status)
    }

    return c.json({success: !error, data, error})
})

app.get('/players', async (c) => {
    const {data, error} = await getPlayers(c.env)

    return c.json({success: !error, data, error})
})

app.post('/lottery/checkin', async (c) => {
    const user = c.get('user')

    try {
        await checkInPlayer(c.env, user.playerId)
        return c.json({success: true})
    } catch (err: any) {
        if (err.status === 409) {
            return c.json({error: 'Player already checked in'}, 409)
        }
        return c.json({error: err.message || 'Internal Server Error'}, 500)
    }
})

app.get("/lottery/checkin/me", async (c) => {
    const user = c.get("user")

    const {data, error} = await getMyCheckin(c.env, user.playerId)

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

app.delete("/lottery/checkin/me", async (c) => {
    const user = c.get("user")
    const {data, error} = await getMyCheckin(c.env, user.playerId)

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

app.get("/me", async (c) => {
    const user = c.get("user") // you already have this middleware
    return c.json({
        success: true,
        data: user as PlayerIdentity,
        error: null
    })
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

app.post('/feedback', async (c) => {

    const body = await c.req.json<{ score: number; feedback: string }>()

    const {score, feedback} = body

    if (isNaN(score) || score < 1 || score > 5 || !feedback.trim()) {
        return c.json({error: 'Invalid score or feedback'}, 400)
    }

    const {data, error} = await submitFeedback(c.env, score, feedback)

    if (error) {
        return c.json({error}, 500)
    }

    return c.json({success: true, data})
})

app.get('/debug/run-metrix', async (c) => {
    const start = Date.now();

    try {
        const result = await updateHoleStatsFromMetrix(c.env);
        const duration = Date.now() - start;

        console.log(`[Metrix] Stats updated in ${duration}ms:`, JSON.stringify(result));

        return c.json({...result, durationMs: duration});
    } catch (error) {
        const duration = Date.now() - start;
        const message = error instanceof Error ? error.message : String(error);

        console.error(`[Metrix] Update failed after ${duration}ms`, message);

        return c.json({success: false, error: message, durationMs: duration}, 500);
    }
});


export default {
    fetch: app.fetch,

    scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
        const start = Date.now();
        console.log("Scheduled task started at", new Date(event.scheduledTime).toISOString());

        try {
            const result = await updateHoleStatsFromMetrix(env);
            console.log("Metrix stats update result:", result);
        } catch (err) {
            console.error("Metrix update failed:", err);
        }

        const duration = Date.now() - start;
        console.log(`Scheduled task completed in ${duration}ms`);
    }
}

app.get('/holes/top-ranked', async (c) => {
    const {data, error} = await getTopRankedHoles(c.env)

    if (error) {
        return c.json({error}, 500)
    }

    return c.json(data)
})

app.get('/holes', async (c) => {
    const {data, error} = await getHoles(c.env)

    if (error) {
        return c.json({error}, 500)
    }

    return c.json(data)
})

app.get('/metrix/players', async (c) => {
    const competitionIdParam = c.req.query('competition_id');
    const competitionId = competitionIdParam ? Number(competitionIdParam) : undefined;

    const {data, error} = await getMetrixPlayers(c.env, competitionId);
    if (error) return c.json({error}, 500);

    return c.json({success: true, data});
});

// stats for selected player
app.get('/metrix/player/stats', async (c) => {

    const user = c.get('user') // always defined
    const userId = String(user.metrixUserId);
    if (!userId) return c.json({error: 'Invalid userId'}, 400);

    const competitionIdParam = c.req.query('competition_id');
    const competitionId = competitionIdParam ? Number(competitionIdParam) : undefined;

    const {data, error} = await getMetrixPlayerStats(c.env, userId, competitionId);
    if (error) return c.json({error}, 404);

    return c.json({success: true, data});
});

app.post('/metrix/check-email', async (c) => {
    const body = await c.req.json<{ email?: string }>()
    const email = (body.email ?? '').trim().toLowerCase()

    if (!email || !email.includes('@')) {
        return c.json({success: false, error: 'Invalid email'}, 400)
    }

    const data = await fetchMetrixIdentityByEmail(email)
    /*
        if (error) return c.json({ success: false, error }, 500)
    */

    const metrixUserId = data ? data.userId : null
    return c.json({success: true, data: {metrixUserId}})
})
