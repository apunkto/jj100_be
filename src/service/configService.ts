import {Env} from "../index"
import {getSupabaseClient} from "../supabase"

export const fetchConfig = async (supabase: any) => {
    const {data, error} = await supabase
        .from('config')
        .select('key, value')

    if (error) {
        throw new Error(`Failed to fetch config: ${error.message}`)
    }

    // Convert the array to an object like { key1: value1, key2: value2 }
    const config: Record<string, string> = {}
    data?.forEach((row: { key: string; value: string }) => {
        config[row.key] = row.value
    })

    return config
}


export const getConfigValue = async (env: Env, key: string) => {
    const supabase = getSupabaseClient(env);

    const {data, error} = await supabase
        .from('config')
        .select('value')
        .eq('key', key)
        .maybeSingle();

    if (error) {
        return {data: null, error};
    }

    if (!data) {
        return {
            data: null,
            error: {message: `Config '${key}' not found`, code: 'config_not_found'},
        };
    }

    return {data: data.value, error: null};
};

