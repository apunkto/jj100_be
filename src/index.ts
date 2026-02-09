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
import predictionRoutes from './prediction/routes'
import {runPredictionPrecompute} from './prediction/precompute'
import type {Env} from './shared/types'
import {DrawDashboardDO} from './lottery/drawDashboardDO'
import {FinalGameDrawDO} from './lottery/finalGameDrawDO'
import {FinalGamePuttingDO} from './lottery/finalGamePuttingDO'

export {DrawDashboardDO, FinalGameDrawDO, FinalGamePuttingDO}

const PUBLIC_PATHS = [
    /^\/metrix\/check-email$/,
    /^\/auth\/pre-login$/,
    /^\/auth\/register-from-metrix$/,
    /^\/admin\/run-metrix$/,
    /^\/admin\/run-prediction-precompute$/,
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
app.route('/prediction', predictionRoutes)

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
        const cronSchedule = event.cron || 'unknown';
        console.log(`Scheduled task started at ${new Date(event.scheduledTime).toISOString()}, cron: ${cronSchedule}`);
        
        switch (cronSchedule) {
            case '0 * * * *':
                // Run Metrix sync every hour
                const metrixStart = Date.now();
                const { error: metrixError, results: metrixResults } = await runMetrixSync(env);
                if (metrixError) {
                    console.error("Metrix scheduler: failed to load competitions", metrixError);
                } else {
                    const metrixDuration = Date.now() - metrixStart;
                    console.log(`Metrix sync completed in ${metrixDuration}ms, synced ${metrixResults.length} competition(s)`);
                }
                break;
                
            case '*/30 * * * *':
                // Run prediction precomputation every 5 minutes
                const predictionStart = Date.now();
                const { error: predictionError, results: predictionResults } = await runPredictionPrecompute(env);
                if (predictionError) {
                    console.error("Prediction precompute: failed to load competitions", predictionError);
                } else {
                    const predictionDuration = Date.now() - predictionStart;
                    const successful = predictionResults.filter(r => r.success).length;
                    console.log(`Prediction precompute completed in ${predictionDuration}ms, processed ${successful}/${predictionResults.length} competition(s)`);
                }
                break;
                
            default:
                console.warn(`Unknown cron schedule: ${cronSchedule}`);
        }
        
        const totalDuration = Date.now() - start;
        console.log(`Scheduled task completed in ${totalDuration}ms`);
    }
}
