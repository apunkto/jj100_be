import type { DurableObjectNamespace } from '@cloudflare/workers-types'

export type Env = {
    SUPABASE_URL: string
    SUPABASE_SERVICE_ROLE_KEY: string
    DRAW_STATE: KVNamespace
    DRAW_DASHBOARD_DO: DurableObjectNamespace
    FINAL_GAME_STATE: KVNamespace
    FINAL_GAME_DRAW_DO: DurableObjectNamespace
    FINAL_GAME_PUTTING_DO: DurableObjectNamespace
}
