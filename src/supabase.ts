import { createClient } from '@supabase/supabase-js'
import {Env} from "./index";

export function getSupabaseClient(env: Env) {
    return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        global: {
            fetch: async (url, init) => {
                const res = await fetch(url, init)

                if (!res.ok) {
                    const text = await res.clone().text()
                    console.error('[Supabase HTTP ERROR]', {
                        url: String(url),
                        method: init?.method,
                        status: res.status,
                        statusText: res.statusText,
                        // avoid dumping huge bodies
                        body: text.slice(0, 2000),
                    })
                }

                return res
            },
        },
    })
}
