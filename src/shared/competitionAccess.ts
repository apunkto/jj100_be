import type {Env} from './types'
import type {PlayerIdentity} from '../player/types'
import {getUserCompetitions} from '../player/service'
import {getSupabaseClient} from './supabase'

export type CompetitionAccessResult =
    | { success: false; error: string; status: number }
    | { success: true }

/** Verify that the user has access to the competition (admin: exists; user: in their list). */
export async function verifyCompetitionAccess(
    env: Env,
    user: PlayerIdentity,
    competitionId: number
): Promise<CompetitionAccessResult> {
    const supabase = getSupabaseClient(env)

    if (user.isAdmin) {
        const { data, error } = await supabase
            .from('metrix_competition')
            .select('id')
            .eq('id', competitionId)
            .maybeSingle()
        if (error) return { success: false, error: error.message, status: 500 }
        if (!data) return { success: false, error: 'Competition not found', status: 404 }
        return { success: true }
    }

    const list = await getUserCompetitions(env, user.metrixUserId)
    if (!list.some((x) => x.id === competitionId)) {
        return { success: false, error: 'Competition not available for this user', status: 403 }
    }
    return { success: true }
}

/** Resolve competition ID from query param or user's active competition. Returns null if invalid. */
export function resolveCompetitionId(
    queryParam: string | undefined,
    activeCompetitionId: number | null
): number | null {
    const fromQuery =
        queryParam != null && queryParam !== '' ? Number(queryParam) : activeCompetitionId
    return fromQuery != null && Number.isFinite(fromQuery) ? fromQuery : null
}
