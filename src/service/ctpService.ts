import { SupabaseClient } from '@supabase/supabase-js'

export const getCtpLeader = async (supabase: SupabaseClient, hole: number) => {
    const { data, error } = await supabase
        .from('ctp_results')
        .select('*, player:player_id(*)')
        .eq('hole', hole)
        .order('distance_cm', { ascending: true })
        .limit(1)

    return { data: data?.[0] ?? null, error }
}


export const submitCtpResult = async (
    supabase: SupabaseClient,
    hole: number,
    player_id: string,
    distance_cm: number
) => {
    // ✅ Get current leader
    const { data: currentLeader, error: leaderError } = await getCtpLeader(supabase, hole)

    if (leaderError) {
        return { data: null, error: leaderError }
    }

    // ✅ Reject if the new throw is not better
    if (currentLeader && distance_cm >= currentLeader.distance_cm) {
        return {
            data: null,
            error: {
                message: `Throw must be less than current CTP (${currentLeader.distance_cm} cm)`,
                code: 'ctp_too_far',
            },
        }
    }

    // ✅ Accept new throw
    const { data, error } = await supabase
        .from('ctp_results')
        .insert([{ hole, player_id, distance_cm }])

    return { data, error }
}
