import {Env} from "../shared/types"
import {getSupabaseClient} from "../shared/supabase"
import {isCompetitionParticipant} from "../metrix/statsService"

const fetchHoleOnly = async (supabase: any, holeFilter: Record<string, any>) => {
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

const fetchHoleWithCtp = async (supabase: any, holeFilter: Record<string, any>) => {
    const result = await fetchHoleOnly(supabase, holeFilter)
    if (result.error || !result.data) return result

    const {hole: holeData} = result.data

    if (!holeData.is_ctp) {
        return {data: {hole: holeData, ctp: []}, error: null}
    }

    const {data: ctpData, error: ctpError} = await supabase
        .from("ctp_results")
        .select("*, player:player_id(*)")
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

// ✅ Public method: Get CTP results for a hole by number (not cached - for CTP page)
export const getCtpByHoleNumber = async (env: Env, holeNumber: number, activeCompetitionId: number | null) => {
    if (activeCompetitionId == null) {
        return {data: [], error: {message: "No active competition", code: "no_active_competition"}}
    }
    const supabase = getSupabaseClient(env)

    const {data: holeData, error: holeError} = await supabase
        .from("hole")
        .select("id, is_ctp")
        .eq("metrix_competition_id", activeCompetitionId)
        .eq("number", holeNumber)
        .maybeSingle()

    if (holeError || !holeData) {
        return {data: [], error: holeError ?? {message: "Hole not found", code: "hole_not_found"}}
    }

    if (!holeData.is_ctp) {
        return {data: [], error: null}
    }

    const {data: ctpData, error: ctpError} = await supabase
        .from("ctp_results")
        .select("*, player:player_id(*)")
        .eq("hole_id", holeData.id)
        .order("distance_cm", {ascending: true})

    return {
        data: ctpError ? [] : ctpData ?? [],
        error: ctpError
    }
}

// ✅ Public method: Get hole by ID
export const getHole = async (env: Env, holeId: number) => {
    const supabase = getSupabaseClient(env)
    return await fetchHoleWithCtp(supabase, {id: holeId})
}

// ✅ Submit CTP result
export const submitCtpResult = async (
    env: Env,
    holeId: number,
    player_id: number,
    metrixUserId: number,
    distance_cm: number,
    competitionId: number
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

    const {data: participates, error: partError} = await isCompetitionParticipant(env, competitionId, metrixUserId)
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

    if (Array.isArray(ctp) && ctp.some(r => r.player_id === player_id)) {
        return {
            data: null,
            error: {
                message: `You have already submitted a CTP result for hole ${hole.number}`,
                code: "ctp_already_submitted"
            }
        }
    }

    const currentLeader = Array.isArray(ctp) && ctp.length > 0 ? ctp[0] : null
    const leaderDistance = currentLeader ? Number(currentLeader.distance_cm) : null

    if (leaderDistance !== null && distance_cm >= leaderDistance) {
        return {
            data: null,
            error: {
                message: `Throw must be less than current CTP (${currentLeader.distance_cm} cm)`,
                code: "ctp_too_far"
            }
        }
    }

    const {data: insertData, error: insertError} = await supabase
        .from("ctp_results")
        .insert([
            {
                hole_id: hole.id,
                player_id,
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
        .select('*, player:player_id(*)')
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
