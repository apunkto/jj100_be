import { SupabaseClient } from '@supabase/supabase-js'

export const getCtpLeader = async (supabase: SupabaseClient, hole: number) => {
    const { data, error } = await supabase
        .from('ctp_results')
        .select('*, player:player_id(*)') // join player table
        .eq('hole', hole)
        .order('distance_cm', { ascending: true })
        .limit(1)

    return { data: data?.[0], error }
}

export const submitCtpResult = async (
    supabase: SupabaseClient,
    hole: number,
    player_id: string,
    distance_cm: number
) => {
    const { data, error } = await supabase
        .from('ctp_results')
        .insert([{ hole, player_id, distance_cm }])
    return { data, error }
}
