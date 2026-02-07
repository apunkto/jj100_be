import type {SupabaseClient} from '@supabase/supabase-js'
import {Env} from "../shared/types"
import {getSupabaseClient} from "../shared/supabase"
import {isCompetitionParticipant} from "../metrix/statsService"
import type {PoolMate} from "./types"

type HoleFilter = { metrix_competition_id?: number; number?: number; id?: number }

const fetchHoleOnly = async (supabase: SupabaseClient, holeFilter: HoleFilter) => {
    const {data: holeData, error: holeError} = await supabase
        .from("hole")
        .select("*")
        .match(holeFilter)
        .maybeSingle()

    if (holeError || !holeData) {
        return {
            data: null,
            error: holeError ?? {message: "Hole not found", code: "hole_not_found"}
        }
    }

    return {data: {hole: holeData}, error: null}
}

const fetchHoleWithCtp = async (supabase: SupabaseClient, holeFilter: HoleFilter) => {
    const result = await fetchHoleOnly(supabase, holeFilter)
    if (result.error || !result.data) return result

    const {hole: holeData} = result.data

    if (!holeData.is_ctp) {
        return {data: {hole: holeData, ctp: []}, error: null}
    }

    const {data: ctpData, error: ctpError} = await supabase
        .from("ctp_results")
        .select("*, player:metrix_player_result_id(id, name, user_id)")
        .eq("hole_id", holeData.id)
        .order("distance_cm", {ascending: true})

    return {
        data: {hole: holeData, ctp: ctpError ? [] : ctpData ?? []},
        error: null
    }
}


// ✅ Public method: Get hole by number (hole only, no CTP - cacheable for course page etc.)
export const getHoleByNumber = async (env: Env, holeNumber: number, activeCompetitionId: number | null) => {
    if (activeCompetitionId == null) {
        return {data: null, error: {message: "No active competition", code: "no_active_competition"}}
    }
    const supabase = getSupabaseClient(env)
    return await fetchHoleOnly(supabase, {metrix_competition_id: activeCompetitionId, number: holeNumber})
}

// ✅ Public method: Get CTP results for a hole by number (single query: hole + ctp_results join)
export const getCtpByHoleNumber = async (env: Env, holeNumber: number, activeCompetitionId: number | null) => {
    if (activeCompetitionId == null) {
        return {data: [], error: {message: "No active competition", code: "no_active_competition"}}
    }
    const supabase = getSupabaseClient(env)

    const {data: row, error} = await supabase
        .from("hole")
        .select("ctp_results(*, player:metrix_player_result_id(id, name, user_id))")
        .eq("metrix_competition_id", activeCompetitionId)
        .eq("number", holeNumber)
        .maybeSingle()

    if (error) return {data: [], error}
    if (!row) return {data: [], error: {message: "Hole not found", code: "hole_not_found"}}

    type CtpRow = { distance_cm?: number; [key: string]: unknown }
    const ctpResults: CtpRow[] = (row as { ctp_results?: CtpRow[] }).ctp_results ?? []
    const sorted = ctpResults.slice().sort((a, b) => (a.distance_cm ?? 0) - (b.distance_cm ?? 0))
    return {data: sorted, error: null}
}

// ✅ Public method: Get hole by ID
export const getHole = async (env: Env, holeId: number) => {
    const supabase = getSupabaseClient(env)
    return await fetchHoleWithCtp(supabase, {id: holeId})
}

/** Get other players in the same start_group (pool) for the given competition. */
export const getPoolMates = async (
    env: Env,
    competitionId: number,
    metrixUserId: number
): Promise<{ data: PoolMate[]; error: { message: string; code: string } | null }> => {
    const supabase = getSupabaseClient(env)
    const userIdStr = String(metrixUserId)

    const {data: myRow, error: myError} = await supabase
        .from('metrix_player_result')
        .select('id, start_group')
        .eq('metrix_competition_id', competitionId)
        .eq('user_id', userIdStr)
        .maybeSingle()

    if (myError || !myRow) {
        return {data: [], error: myError ?? {message: 'Player not found', code: 'player_not_found'}}
    }

    const startGroup = myRow.start_group
    if (startGroup == null || !Number.isFinite(startGroup)) {
        return {data: [], error: null}
    }

    const {data: rows, error: listError} = await supabase
        .from('metrix_player_result')
        .select('id, name, user_id')
        .eq('metrix_competition_id', competitionId)
        .eq('start_group', startGroup)
        .neq('user_id', userIdStr)

    if (listError) return {data: [], error: listError}
    const list: PoolMate[] = (rows ?? []).map((r) => ({
        id: r.id,
        name: r.name ?? null,
        user_id: r.user_id,
    }))
    return {data: list, error: null}
}

// ✅ Submit CTP result (targetMetrixPlayerResultId = metrix_player_result.id for the player receiving the CTP; creatorPlayerId = player.id of logged-in user)
export const submitCtpResult = async (
    env: Env,
    holeId: number,
    submitterMetrixUserId: number,
    targetMetrixPlayerResultId: number,
    distance_cm: number,
    competitionId: number,
    creatorPlayerId: number
) => {
    const supabase = getSupabaseClient(env)

    // Check if CTP is enabled for this competition
    const {data: competition, error: compError} = await supabase
        .from('metrix_competition')
        .select('ctp_enabled')
        .eq('id', competitionId)
        .maybeSingle()

    if (compError || !competition || !competition.ctp_enabled) {
        return {
            data: null,
            error: {
                message: "CTP submission is currently disabled",
                code: "ctp_disabled"
            }
        }
    }

    const {data, error: holeError} = await getHole(env, holeId)

    if (holeError || !data) {
        return {
            data: null,
            error: holeError ?? {message: "Hole not found", code: "hole_not_found"}
        }
    }

    const {hole} = data
    const ctp = "ctp" in data ? data.ctp ?? [] : []

    if (!hole.is_ctp) {
        return {
            data: null,
            error: {
                message: `Hole ${hole.number} is not a CTP hole`,
                code: "not_ctp_hole"
            }
        }
    }

    const {data: participates, error: partError} = await isCompetitionParticipant(env, competitionId, submitterMetrixUserId)
    if (partError) {
        return {
            data: null,
            error: {
                message: "Võistluse andmeid ei leitud",
                code: "competition_not_available"
            }
        }
    }
    if (!participates) {
        return {
            data: null,
            error: {
                message: "Sa ei osale võistlusel!",
                code: "not_competition_participant"
            }
        }
    }

    // Load submitter and target metrix_player_result rows (for proxy: verify same pool)
    const {data: submitterRow, error: submitterErr} = await supabase
        .from('metrix_player_result')
        .select('id, start_group')
        .eq('metrix_competition_id', competitionId)
        .eq('user_id', String(submitterMetrixUserId))
        .maybeSingle()

    if (submitterErr || !submitterRow) {
        return {
            data: null,
            error: {message: "Võistluse andmeid ei leitud", code: "competition_not_available"}
        }
    }

    const {data: targetRow, error: targetErr} = await supabase
        .from('metrix_player_result')
        .select('id, start_group, metrix_competition_id')
        .eq('id', targetMetrixPlayerResultId)
        .maybeSingle()

    if (targetErr || !targetRow) {
        return {
            data: null,
            error: {message: "Mängijat ei leitud", code: "target_not_found"}
        }
    }

    if (targetRow.metrix_competition_id !== competitionId) {
        return {
            data: null,
            error: {message: "Mängija ei osale selles võistluses", code: "not_same_pool"}
        }
    }

    // Proxy submission: target must be in same start_group as submitter
    if (targetMetrixPlayerResultId !== submitterRow.id) {
        const sg = submitterRow.start_group
        const tg = targetRow.start_group
        if (sg == null || tg == null || sg !== tg) {
            return {
                data: null,
                error: {message: "Saad sisestada CTP ainult sama raja mängijatele", code: "not_same_pool"}
            }
        }
    }

    if (Array.isArray(ctp) && ctp.some((r: { metrix_player_result_id?: number }) => r.metrix_player_result_id === targetMetrixPlayerResultId)) {
        return {
            data: null,
            error: {
                message: `CTP tulemus on sellele korvile juba sisestatud`,
                code: "ctp_already_submitted"
            }
        }
    }

    const currentLeader = Array.isArray(ctp) && ctp.length > 0 ? ctp[0] : null
    const leaderDistance = currentLeader ? Number((currentLeader as { distance_cm?: number }).distance_cm) : null

    if (leaderDistance !== null && distance_cm >= leaderDistance) {
        return {
            data: null,
            error: {
                message: `Throw must be less than current CTP (${(currentLeader as { distance_cm?: number }).distance_cm} cm)`,
                code: "ctp_too_far"
            }
        }
    }

    const {data: insertData, error: insertError} = await supabase
        .from("ctp_results")
        .insert([
            {
                hole_id: hole.id,
                metrix_player_result_id: targetMetrixPlayerResultId,
                creator_player_id: creatorPlayerId,
                distance_cm
            }
        ])

    return {data: insertData, error: insertError}
}

export const getCtpHoles = async (env: Env, competitionId: number) => {
    const supabase = getSupabaseClient(env);

    const {data: holes, error: holeError} = await supabase
        .from('hole')
        .select('*')
        .eq('is_ctp', true)
        .eq('metrix_competition_id', competitionId)
        .order('number', {ascending: true});

    if (holeError || !holes) {
        return {data: [], error: holeError ?? {message: "No CTP holes found", code: "ctp_hole_not_found"}};
    }

    // Fetch CTP results for all holes
    const holeIds = holes.map(h => h.id);

    const {data: ctpResults, error: ctpError} = await supabase
        .from('ctp_results')
        .select('*, player:metrix_player_result_id(id, name, user_id)')
        .in('hole_id', holeIds)
        .order('distance_cm', {ascending: true});

    if (ctpError) {
        return {data: holes.map(hole => ({hole, ctp: []})), error: null};
    }

    // Group CTP results by hole
    const grouped: Record<number, typeof ctpResults> = {};
    for (const result of ctpResults ?? []) {
        if (!grouped[result.hole_id]) {
            grouped[result.hole_id] = [];
        }
        grouped[result.hole_id].push(result);
    }

    const enriched = holes.map(hole => ({
        hole,
        ctp: grouped[hole.id] ?? []
    }));

    return {data: enriched, error: null};
};

export const getTopRankedHoles = async (env: Env, competitionId: number | null = null) => {
    const supabase = getSupabaseClient(env)

    let query = supabase.from('hole').select('*').order('rank', {ascending: true}).limit(10)
    if (competitionId != null && Number.isFinite(competitionId)) {
        query = query.eq('metrix_competition_id', competitionId)
    }

    const {data, error} = await query

    if (error || !data) {
        return {
            data: [],
            error: error ?? {message: 'Failed to fetch ranked holes', code: 'rank_fetch_error'}
        }
    }

    return {
        data: data.map(hole => ({hole, ctp: []})), // include empty ctp for compatibility
        error: null
    }
}

export const getHoles = async (env: Env, competitionId: number | null = null) => {
    const supabase = getSupabaseClient(env)

    let query = supabase.from('hole').select('*').order('number', {ascending: true})
    if (competitionId != null && Number.isFinite(competitionId)) {
        query = query.eq('metrix_competition_id', competitionId)
    }

    const {data, error} = await query

    if (error || !data) {
        return {
            data: [],
            error: error ?? {message: 'Failed to fetch holes', code: 'hole_fetch_error'}
        }
    }

    return {
        data: data.map(hole => ({hole, ctp: []})), // include empty ctp for compatibility
        error: null
    }
}

/** Get count of holes for the user's active competition. */
export const getHoleCount = async (env: Env, activeCompetitionId: number | null) => {
    if (activeCompetitionId == null) {
        return {data: null, error: {message: 'No active competition', code: 'no_active_competition'}}
    }
    const supabase = getSupabaseClient(env)
    const {count, error} = await supabase
        .from('hole')
        .select('*', {count: 'exact', head: true})
        .eq('metrix_competition_id', activeCompetitionId)

    if (error) {
        return {data: null, error: error ?? {message: 'Failed to fetch hole count', code: 'count_error'}}
    }
    return {data: count ?? 0, error: null}
}
