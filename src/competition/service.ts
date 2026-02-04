import {getSupabaseClient} from '../shared/supabase'
import type {Env} from '../shared/types'

export async function getConfigValue(env: Env, key: string): Promise<{ data: any | null; error: { message: string; code?: string } | null }> {
    const supabase = getSupabaseClient(env)
    const { data, error } = await supabase
        .from('config')
        .select('value')
        .eq('key', key)
        .maybeSingle()
    if (error) {
        return { data: null, error }
    }
    if (!data) {
        return {
            data: null,
            error: { message: `Config '${key}' not found`, code: 'config_not_found' },
        }
    }
    return { data: data.value, error: null }
}
