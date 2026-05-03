import type {DurableObjectNamespace} from '@cloudflare/workers-types'

export type Env = {
    SUPABASE_URL: string
    SUPABASE_SERVICE_ROLE_KEY: string
    /** Disc Golf Metrix Alps API — set via `wrangler secret put METRIX_ALPS_INTEGRATION_CODE` or `.dev.vars` */
    METRIX_ALPS_INTEGRATION_CODE?: string
    DRAW_STATE: KVNamespace
    DRAW_DASHBOARD_DO: DurableObjectNamespace
    FINAL_GAME_STATE: KVNamespace
    FINAL_GAME_DRAW_DO: DurableObjectNamespace
    FINAL_GAME_PUTTING_DO: DurableObjectNamespace
    LED_SCREEN_CONTROL_DO: DurableObjectNamespace
}
