import {Env} from "../shared/types"
import {getSupabaseClient} from "../shared/supabase"
import {isCompetitionParticipant} from "../metrix/statsService"

export type CheckedInPlayer = {
    id: number
    player: {
        id: number
        name: string
    }
    prize_won: boolean,
    final_game: boolean,
    final_game_order: number | null
}

export const checkInPlayer = async (env: Env, player_id: number, metrixUserId: number, competitionId: number) => {
    const supabase = getSupabaseClient(env)

    // Check if check-in is enabled for this competition
    const {data: competition, error: compError} = await supabase
        .from('metrix_competition')
        .select('checkin_enabled')
        .eq('id', competitionId)
        .maybeSingle()
    
    if (compError || !competition || !competition.checkin_enabled) {
        const err = new Error('Check-in is currently disabled')
        // @ts-ignore
        err.status = 403
        throw err
    }

    const {data: participates, error: partError} = await isCompetitionParticipant(env, competitionId, metrixUserId)
    if (partError) {
        const err: any = new Error('Võistluse andmeid ei leitud')
        err.code = 'competition_not_available'
        err.status = 503
        throw err
    }
    if (!participates) {
        const err: any = new Error('Sa ei osale võistlusel!')
        err.code = 'not_competition_participant'
        err.status = 403
        throw err
    }

    const {data: existing} = await supabase
        .from('lottery_checkin')
        .select('id')
        .eq('player_id', player_id)
        .eq('metrix_competition_id', competitionId)
        .maybeSingle()

    if (existing) {
        const err = new Error('Player already checked in')
        // @ts-ignore
        err.status = 409
        throw err
    }

    const {data, error} = await supabase
        .from('lottery_checkin')
        .insert([{player_id, metrix_competition_id: competitionId}])

    if (error) {
        throw new Error('Failed to insert check-in')
    }

    return data
}

export const getCheckedInPlayers = async (env: Env, competitionId: number) => {
    const supabase = getSupabaseClient(env)

    const {data, error} = await supabase
        .from('lottery_checkin')
        .select('*, player:player_id(id, name)')
        .eq('metrix_competition_id', competitionId)
        .order('created_date', {ascending: true})

    return {data, error}
}



export const drawRandomWinner = async (env: Env, competitionId: number, finalGame = false): Promise<{ data: CheckedInPlayer | null, error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env)

    // 🧠 Build correct filter
    let query = supabase
        .from('lottery_checkin')
        .select('*, player:player_id(id, name)')
        .eq('metrix_competition_id', competitionId)

    if (!finalGame) {
        query = query.eq('prize_won', false)
    } else {
        query = query.eq('final_game', false)
    }

    const { data: eligiblePlayers, error } = await query

    if (error || !eligiblePlayers || eligiblePlayers.length === 0) {
        return { data: null, error: { message: 'No eligible players' } }
    }

    // 🎯 Pick random winner
    const winner = eligiblePlayers[Math.floor(Math.random() * eligiblePlayers.length)] as CheckedInPlayer

    // 🎯 Update winner's record
    if (!finalGame) {
        const { error: updateError } = await supabase
            .from('lottery_checkin')
            .update({ prize_won: true })
            .eq('id', winner.id)

        if (updateError) {
            return { data: null, error: { message: updateError.message } }
        }
    }

    return { data: winner, error: null }
}


// Confirm player to final game
export const confirmFinalGamePlayer = async (env: Env, checkinId: number, competitionId: number) => {
    const supabase = getSupabaseClient(env)

    // First: Find the current max final_game_order for this competition
    const { data: maxOrderData, error: maxError } = await supabase
        .from('lottery_checkin')
        .select('final_game_order')
        .eq('final_game', true)
        .eq('metrix_competition_id', competitionId)
        .order('final_game_order', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (maxError) {
        return { error: { message: maxError.message } }
    }

    const nextOrder = (maxOrderData?.final_game_order ?? 0) + 1

    // Then: Update the chosen check-in
    const { error: updateError } = await supabase
        .from('lottery_checkin')
        .update({
            final_game: true,
            final_game_order: nextOrder
        })
        .eq('id', checkinId)

    if (updateError) {
        return { error: { message: updateError.message } }
    }

    return { error: null }
}


// Delete player completely
export const deleteCheckinPlayer = async (env: Env, checkinId: number) => {
    const supabase = getSupabaseClient(env)

    const { error } = await supabase
        .from('lottery_checkin')
        .delete()
        .eq('id', checkinId)

    if (error) {
        return { error: { message: error.message } }
    }

    return { error: null }
}

export const getMyCheckin = async (env: Env, player_id: number, competitionId: number) => {
    const supabase = getSupabaseClient(env)

    const { data, error } = await supabase
        .from('lottery_checkin')
        .select('*')
        .eq('player_id', player_id)
        .eq('metrix_competition_id', competitionId)
        .maybeSingle()

    return { data, error }
}
