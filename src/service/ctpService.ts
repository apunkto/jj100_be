import { Env } from "../index"
import { getSupabaseClient } from "../supabase"
import {getConfigValue} from "./configService";

const fetchHoleWithCtp = async (supabase: any, holeFilter: Record<string, any>) => {
    // Get hole
    const { data: holeData, error: holeError } = await supabase
        .from("hole")
        .select("*")
        .match(holeFilter)
        .maybeSingle()

    if (holeError || !holeData) {
        return {
            data: null,
            error: holeError ?? { message: "Hole not found", code: "hole_not_found" }
        }
    }

    // If not a CTP hole, skip CTP results
    if (!holeData.is_ctp) {
        return { data: { hole: holeData, ctp: [] }, error: null }
    }

    const { data: ctpData, error: ctpError } = await supabase
        .from("ctp_results")
        .select("*, player:player_id(*)")
        .eq("hole_id", holeData.id)
        .order("distance_cm", { ascending: true })

    return {
        data: { hole: holeData, ctp: ctpError ? [] : ctpData ?? [] },
        error: null
    }
}


// ✅ Public method: Get hole by number
export const getHoleByNumber = async (env: Env, holeNumber: number) => {
    const supabase = getSupabaseClient(env)
    return await fetchHoleWithCtp(supabase, { number: holeNumber })
}

// ✅ Public method: Get hole by ID
export const getHole = async (env: Env, holeId: number) => {
    const supabase = getSupabaseClient(env)
    return await fetchHoleWithCtp(supabase, { id: holeId })
}

// ✅ Submit CTP result
export const submitCtpResult = async (
    env: Env,
    holeId: number,
    player_id: string,
    distance_cm: number
) => {
    const supabase = getSupabaseClient(env)

    const { data: ctpEnabled, error: configError } = await getConfigValue(env, "ctp_enabled");
    if (configError || ctpEnabled !== "true") {
        return {
            data: null,
            error: {
                message: "CTP submission is currently disabled",
                code: "ctp_disabled"
            }
        }
    }

    const { data, error: holeError } = await getHole(env, holeId)

    if (holeError || !data) {
        return {
            data: null,
            error: holeError ?? { message: "Hole not found", code: "hole_not_found" }
        }
    }

    const { hole, ctp: currentLeader } = data

    if (!hole.is_ctp) {
        return {
            data: null,
            error: {
                message: `Hole ${hole.number} is not a CTP hole`,
                code: "not_ctp_hole"
            }
        }
    }

    if (currentLeader && distance_cm >= currentLeader.distance_cm) {
        return {
            data: null,
            error: {
                message: `Throw must be less than current CTP (${currentLeader.distance_cm} cm)`,
                code: "ctp_too_far"
            }
        }
    }

    const { data: insertData, error: insertError } = await supabase
        .from("ctp_results")
        .insert([
            {
                hole_id: hole.id,
                player_id,
                distance_cm
            }
        ])

    return { data: insertData, error: insertError }
}

export const getCtpHoles = async (env: Env) => {
    const supabase = getSupabaseClient(env);

    const { data: holes, error: holeError } = await supabase
        .from('hole')
        .select('*')
        .eq('is_ctp', true)
        .order('number', { ascending: true });

    if (holeError || !holes) {
        return { data: [], error: holeError ?? { message: "No CTP holes found", code: "ctp_hole_not_found" } };
    }

    // Fetch CTP results for all holes
    const holeIds = holes.map(h => h.id);

    const { data: ctpResults, error: ctpError } = await supabase
        .from('ctp_results')
        .select('*, player:player_id(*)')
        .in('hole_id', holeIds)
        .order('distance_cm', { ascending: true });

    if (ctpError) {
        return { data: holes.map(hole => ({ hole, ctp: [] })), error: null };
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

    return { data: enriched, error: null };
};

