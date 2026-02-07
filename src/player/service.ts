import {Env} from "../shared/types";
import {getSupabaseClient} from "../shared/supabase";
import type {
    ParticipationLeaderboard,
    PlayerIdentity,
    UserCompetition,
    UserCompetitionWithDate,
    UserParticipation
} from "./types";

export async function checkPlayerExistsByEmail(env: Env, email: string): Promise<boolean> {
    const supabase = getSupabaseClient(env)
    const normalizedEmail = email.trim().toLowerCase()

    const {data, error} = await supabase
        .from('player')
        .select('id')
        .eq('email', normalizedEmail)
        .maybeSingle()

    if (error) throw new Error(error.message)
    return data !== null
}


export async function getUserCompetitions(env: Env, metrixUserId: number): Promise<UserCompetition[]> {
    const supabase = getSupabaseClient(env)
    const userIdStr = String(metrixUserId)
    const { data: resultRows, error: resultError } = await supabase
        .from('metrix_player_result')
        .select('metrix_competition_id')
        .eq('user_id', userIdStr)
    if (resultError) throw new Error(resultError.message)
    const competitionIds = [...new Set((resultRows ?? []).map((r: { metrix_competition_id: number }) => r.metrix_competition_id))]
    if (competitionIds.length === 0) return []
    const { data: compRows, error: compError } = await supabase
        .from('metrix_competition')
        .select('id, name')
        .in('id', competitionIds)
    if (compError) throw new Error(compError.message)
    return (compRows ?? []).map((r: { id: number; name: string | null }) => ({ id: r.id, name: r.name }))
}

async function getUserCompetitionsWithDates(env: Env, metrixUserId: number): Promise<UserCompetitionWithDate[]> {
    const supabase = getSupabaseClient(env)
    const userIdStr = String(metrixUserId)
    const { data: resultRows, error: resultError } = await supabase
        .from('metrix_player_result')
        .select('metrix_competition_id')
        .eq('user_id', userIdStr)
    if (resultError) throw new Error(resultError.message)
    const competitionIds = [...new Set((resultRows ?? []).map((r: { metrix_competition_id: number }) => r.metrix_competition_id))]
    if (competitionIds.length === 0) return []
    const { data: compRows, error: compError } = await supabase
        .from('metrix_competition')
        .select('id, name, competition_date')
        .in('id', competitionIds)
    if (compError) throw new Error(compError.message)
    return (compRows ?? []).map((r: { id: number; name: string | null; competition_date: string | null }) => ({
        id: r.id,
        name: r.name,
        competition_date: r.competition_date ?? null,
    }))
}

function pickDefaultCompetition(competitions: UserCompetitionWithDate[]): number {
    const today = new Date().toISOString().slice(0, 10)
    const future = competitions
        .filter((c) => c.competition_date != null && c.competition_date >= today)
        .sort((a, b) => (a.competition_date!.localeCompare(b.competition_date!)))
    if (future.length > 0) return future[0].id
    const past = competitions
        .filter((c) => c.competition_date != null && c.competition_date < today)
        .sort((a, b) => (b.competition_date!.localeCompare(a.competition_date!)))
    if (past.length > 0) return past[0].id
    return competitions[0].id
}

export async function resolvePlayerIdentity(env: Env, email: string): Promise<PlayerIdentity> {
    const supabase = getSupabaseClient(env)
    const normalizedEmail = email.trim().toLowerCase()

    const existing = await supabase
        .from('player')
        .select('id, email, metrix_user_id, name, active_competition_id, is_admin')
        .eq('email', normalizedEmail)
        .maybeSingle()

    if (existing.error) throw new Error(existing.error.message)

    if (!existing.data) {
        throw new Error('Unauthorized')
    }

    let activeCompetitionId: number | null = existing.data.active_competition_id ?? null

    if (activeCompetitionId == null) {
        const withDates = await getUserCompetitionsWithDates(env, existing.data.metrix_user_id)
        if (withDates.length === 1) {
            activeCompetitionId = withDates[0].id
            await supabase.from('player').update({ active_competition_id: activeCompetitionId }).eq('id', existing.data.id)
        } else if (withDates.length > 1) {
            activeCompetitionId = pickDefaultCompetition(withDates)
            await supabase.from('player').update({ active_competition_id: activeCompetitionId }).eq('id', existing.data.id)
        }
    }

    return {
        playerId: existing.data.id,
        email: existing.data.email,
        metrixUserId: existing.data.metrix_user_id,
        name: existing.data.name,
        activeCompetitionId,
        isAdmin: existing.data.is_admin ?? false,
    }
}


export async function getUserParticipation(env: Env, userMetrixId: number): Promise<UserParticipation[]> {
    const supabase = getSupabaseClient(env)
    const {data, error} = await supabase
        .from('player_participation')
        .select('year, rank, score')
        .eq('metrix_user_id', userMetrixId)
        .order('year', {ascending: false})

    if (error) {
        throw new Error(error.message)
    }

    return data.map(d => ({
        year: d.year,
        place: d.rank,
        score: d.score,
    }))
}
export async function getParticipationLeaderboard(env: Env): Promise<ParticipationLeaderboard> {
    const supabase = getSupabaseClient(env)

    const pageSize = 1000
    let from = 0
    const all: Array<{metrixUserId: number; name: string; participationYears: number}> = []

    while (true) {
        const to = from + pageSize - 1

        const { data, error } = await supabase
            .from("participation_leaderboard")
            .select("metrix_user_id, player_name, participation_years")
            .order("participation_years", { ascending: false })
            .order("metrix_user_id", { ascending: true })
            .range(from, to)

        if (error) throw new Error(error.message)

        type LeaderboardRow = { metrix_user_id: number; player_name: string; participation_years: number }
        const chunk = (data ?? []).map((d: LeaderboardRow) => ({
            metrixUserId: d.metrix_user_id,
            name: d.player_name,
            participationYears: d.participation_years,
        }))

        all.push(...chunk)

        if (chunk.length < pageSize) break
        from += pageSize
    }

    // Build buckets
    const map = new Map<number, Array<{ metrixUserId: number; name: string }>>()

    for (const l of all) {
        const arr = map.get(l.participationYears) ?? []
        arr.push({ metrixUserId: l.metrixUserId, name: l.name })
        map.set(l.participationYears, arr)
    }

    const amounts = Array.from(map.keys()).sort((a, b) => b - a)

    const buckets = amounts.map((amount) => {
        const players = map.get(amount)!
        players.sort((a, b) => a.name.localeCompare(b.name, "et"))
        return { amount, players }
    })

    return {
        maxAmount: amounts[0] ?? 0,
        buckets,
    }
}
