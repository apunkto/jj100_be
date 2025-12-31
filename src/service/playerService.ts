import {Env} from "../index";
import {getSupabaseClient} from "../supabase";
import {fetchMetrixIdentityByEmail} from "./metrixService";

export type PlayerIdentity = {
    playerId: number
    email: string
    metrixUserId: number
    name: string
}

export type UserParticipation = {
    year: number
    place: number
    score: number
}

export type ParticipationLeader = {
    metrixUserId: number
    name: string
    participationYears: number
}

export async function resolvePlayerIdentity(env: Env, email: string): Promise<PlayerIdentity> {
    const supabase = getSupabaseClient(env)
    const normalizedEmail = email.trim().toLowerCase()

    // 1) try DB
    const existing = await supabase
        .from('player')
        .select('id, email, metrix_user_id, name')
        .eq('email', normalizedEmail)
        .maybeSingle()

    if (existing.error) throw new Error(existing.error.message)

    if (existing.data) {
        return {
            playerId: existing.data.id,
            email: existing.data.email,
            metrixUserId: existing.data.metrix_user_id,
            name: existing.data.name,
        }
    }

    // 2) not found -> query Metrix (must return userId+name)
    const metrix = await fetchMetrixIdentityByEmail(normalizedEmail)
    if (!metrix) throw new Error('NO_METRIX_USER')

    // 3) insert/upsert (email unique)
    const upsert = await supabase
        .from('player')
        .upsert(
            {
                email: normalizedEmail,
                metrix_user_id: metrix.userId,
                name: metrix.name,
            },
            {onConflict: 'metrix_user_id'}
        )
        .select('id, email, metrix_user_id, name')
        .single()

    if (upsert.error) throw new Error(upsert.error.message)

    return {
        playerId: upsert.data.id,
        email: upsert.data.email,
        metrixUserId: upsert.data.metrix_user_id,
        name: upsert.data.name,
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

export async function getParticipationLeaders(env: Env): Promise<ParticipationLeader[]> {
    const supabase = getSupabaseClient(env)

    const pageSize = 1000
    let from = 0
    const all: any[] = []

    while (true) {
        const to = from + pageSize - 1

        const { data, error } = await supabase
            .from('participation_leaderboard')
            .select('metrix_user_id, player_name, participation_years')
            .order('participation_years', { ascending: false })
            .order('metrix_user_id', { ascending: true })
            .range(from, to)

        if (error) throw new Error(error.message)

        const chunk = data ?? []
        all.push(...chunk)

        if (chunk.length < pageSize) break
        from += pageSize
    }

    return all.map(d => ({
        metrixUserId: d.metrix_user_id,
        name: d.player_name,
        participationYears: d.participation_years,
    }))
}


