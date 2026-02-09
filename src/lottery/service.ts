import {Env} from "../shared/types"
import {getSupabaseClient} from "../shared/supabase"
import {isCompetitionParticipant} from "../metrix/statsService"

export type CheckedInPlayer = {
    id: number
    player: {
        id: number
        name: string
    }
    prize_won: boolean
}

export type FinalGameParticipant = {
    id: number
    player: { id: number; name: string }
    final_game_order: number
    last_level: number
    last_result: 'in' | 'out' | null
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
        throw Object.assign(new Error('Check-in is currently disabled'), { status: 403 })
    }

    const {data: participates, error: partError} = await isCompetitionParticipant(env, competitionId, metrixUserId)
    if (partError) {
        throw Object.assign(new Error('Võistluse andmeid ei leitud'), { code: 'competition_not_available', status: 503 })
    }
    if (!participates) {
        throw Object.assign(new Error('Sa ei osale võistlusel!'), { code: 'not_competition_participant', status: 403 })
    }

    const {data: existing} = await supabase
        .from('lottery_checkin')
        .select('id')
        .eq('player_id', player_id)
        .eq('metrix_competition_id', competitionId)
        .maybeSingle()

    if (existing) {
        throw Object.assign(new Error('Player already checked in'), { status: 409 })
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



export const getFinalGameParticipants = async (env: Env, competitionId: number) => {
    const supabase = getSupabaseClient(env)
    const { data, error } = await supabase
        .from('final_game_participant')
        .select('id, final_game_order, last_level, last_result, player:player_id(id, name)')
        .eq('metrix_competition_id', competitionId)
        .order('final_game_order', { ascending: true })
    return { data: data as FinalGameParticipant[] | null, error }
}

export const getEligibleFinalGameCount = async (env: Env, competitionId: number): Promise<number> => {
    const supabase = getSupabaseClient(env)
    const { data, error } = await supabase.rpc('get_eligible_final_game_count', {
        p_competition_id: competitionId,
    })
    if (error) return 0
    return Number(data ?? 0)
}

export const drawRandomWinner = async (env: Env, competitionId: number, finalGame = false): Promise<{ data: CheckedInPlayer | null; participantNames: string[]; error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env)

    let query = supabase
        .from('lottery_checkin')
        .select('*, player:player_id(id, name)')
        .eq('metrix_competition_id', competitionId)

    if (!finalGame) {
        query = query.eq('prize_won', false)
    } else {
        const { data: inFinal } = await supabase
            .from('final_game_participant')
            .select('player_id')
            .eq('metrix_competition_id', competitionId)
        const inFinalIds = (inFinal ?? []).map((r) => r.player_id)
        if (inFinalIds.length > 0) {
            query = query.not('player_id', 'in', `(${inFinalIds.join(',')})`)
        }
    }

    const { data: eligiblePlayers, error } = await query

    if (error || !eligiblePlayers || eligiblePlayers.length === 0) {
        return { data: null, participantNames: [], error: { message: 'No eligible players' } }
    }

    const participantNames = eligiblePlayers.map((p) => (p as CheckedInPlayer).player?.name ?? '').filter(Boolean)

    const winner = eligiblePlayers[Math.floor(Math.random() * eligiblePlayers.length)] as CheckedInPlayer

    if (!finalGame) {
        const { error: updateError } = await supabase
            .from('lottery_checkin')
            .update({ prize_won: true })
            .eq('id', winner.id)

        if (updateError) {
            return { data: null, participantNames: [], error: { message: updateError.message } }
        }
    }

    return { data: winner, participantNames, error: null }
}


export const removeFinalGameParticipant = async (env: Env, finalGameId: number, competitionId: number): Promise<{ error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env)
    const { error: deleteError } = await supabase
        .from('final_game_participant')
        .delete()
        .eq('id', finalGameId)
        .eq('metrix_competition_id', competitionId)
    if (deleteError) return { error: { message: deleteError.message } }
    const { error: renumError } = await supabase.rpc('renumber_final_game_participants', {
        p_competition_id: competitionId,
    })
    if (renumError) return { error: { message: renumError.message } }
    return { error: null }
}

export const addFinalGameParticipant = async (env: Env, competitionId: number, playerId: number): Promise<{ error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env)
    const { data: maxData } = await supabase
        .from('final_game_participant')
        .select('final_game_order')
        .eq('metrix_competition_id', competitionId)
        .order('final_game_order', { ascending: false })
        .limit(1)
        .maybeSingle()
    const nextOrder = ((maxData?.final_game_order as number) ?? 0) + 1
    const { error } = await supabase
        .from('final_game_participant')
        .insert({ metrix_competition_id: competitionId, player_id: playerId, final_game_order: nextOrder })
    if (error) return { error: { message: error.message } }
    return { error: null }
}

export const confirmFinalGamePlayer = async (env: Env, checkinId: number, competitionId: number) => {
    const supabase = getSupabaseClient(env)
    const { data: newId, error } = await supabase.rpc('confirm_final_game_player', {
        p_checkin_id: checkinId,
        p_competition_id: competitionId,
    })
    if (error) return { error: { message: error.message } }
    if (!newId) return { error: { message: 'Check-in not found' } }
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
