import {SupabaseClient} from '@supabase/supabase-js'
import {Env} from "../index";
import {getSupabaseClient} from "../supabase";

export const getPlayers = async (env: Env) => {
    const supabase = getSupabaseClient(env)
    return supabase.from('player').select('*').order('name', {ascending: true})
}
