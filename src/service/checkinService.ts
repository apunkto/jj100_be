// src/services/checkinService.ts
import {Env} from "../index"
import {getSupabaseClient} from "../supabase"
import {getConfigValue} from "./configService";

export const checkInPlayer = async (env: Env, player_id: number) => {
    const supabase = getSupabaseClient(env)

    // ✅ First: Check if check-in is enabled
    const {data: checkinEnabled, error: configError} = await getConfigValue(env, 'checkin_enabled')
    if (configError || checkinEnabled !== 'true') {
        const err = new Error('Check-in is currently disabled')
        // @ts-ignore
        err.status = 403
        throw err
    }

    // ✅ Second: Check if player already checked in
    const {data: existing, error: checkError} = await supabase
        .from('lottery_checkin')
        .select('id')
        .eq('player_id', player_id)
        .maybeSingle()

    if (existing) {
        const err = new Error('Player already checked in')
        // @ts-ignore
        err.status = 409
        throw err
    }

    // ✅ Insert new check-in
    const {data, error} = await supabase
        .from('lottery_checkin')
        .insert([{player_id}])

    if (error) {
        throw new Error('Failed to insert check-in')
    }

    return data
}
