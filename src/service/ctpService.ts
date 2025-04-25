import { Env } from "../index"
import { getSupabaseClient } from "../supabase"

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

    // If not a CTP hole, skip CTP leader
    if (!holeData.is_ctp) {
        return { data: { hole: holeData, ctp: null }, error: null }
    }

    const { data: ctpData, error: ctpError } = await supabase
        .from("ctp_results")
        .select("*, player:player_id(*)")
        .eq("hole_id", holeData.id)
        .order("distance_cm", { ascending: true })
        .limit(1)
        .maybeSingle()

    return {
        data: { hole: holeData, ctp: ctpError ? null : ctpData ?? null },
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
