import {Hono} from 'hono'
import {cors} from 'hono/cors'
import type {PlayerIdentity} from './player/types'
import {resolvePlayerIdentity} from './player/service'
import {verifySupabaseJwt} from "./auth/service";
import type {ExecutionContext, ScheduledEvent} from '@cloudflare/workers-types';
import holeRoutes from './hole/routes'
import playerRoutes from './player/routes'
import lotteryRoutes from './lottery/routes'
import authRoutes from './auth/routes'
import metrixRoutes from './metrix/routes'
import competitionRoutes from './competition/routes'
import feedbackRoutes from './feedback/routes'
import adminRoutes, {runMetrixSync} from './admin/routes'
import type {Env} from './shared/types'

const PUBLIC_PATHS = [
    /^\/metrix\/check-email$/,
    /^\/auth\/pre-login$/,
    /^\/auth\/register-from-metrix$/,
    /^\/admin\/run-metrix$/,
]

// Re-export Env type for backward compatibility
export type {Env} from './shared/types'

type HonoVars = { user: PlayerIdentity }
const app = new Hono<{ Bindings: Env; Variables: HonoVars }>()

app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'DELETE'],
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

// Mount route controllers
app.route('/', holeRoutes)
app.route('/player', playerRoutes)
app.route('/lottery', lotteryRoutes)
app.route('/auth', authRoutes)
app.route('/metrix', metrixRoutes)
app.route('/', competitionRoutes)
app.route('/feedback', feedbackRoutes)
app.route('/admin', adminRoutes)

// Mount /me at root level (not under /player prefix)
app.get('/me', async (c) => {
    const user = c.get('user')
    return c.json({
        success: true,
        data: user as PlayerIdentity,
        error: null
    })
})

export default {
    fetch: app.fetch,

    scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
        const start = Date.now();
        console.log("Scheduled task started at", new Date(event.scheduledTime).toISOString());
        const { error, results } = await runMetrixSync(env);
        if (error) {
            console.error("Metrix scheduler: failed to load competitions", error);
            return;
        }
        const duration = Date.now() - start;
        console.log(`Scheduled task completed in ${duration}ms, synced ${results.length} competition(s)`);
    }
}
