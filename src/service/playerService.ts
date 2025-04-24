import { SupabaseClient } from '@supabase/supabase-js'

export const getPlayers = async (supabase: SupabaseClient) => {
    return await supabase.from('player').select('*')
}
