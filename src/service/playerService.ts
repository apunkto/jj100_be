import {Env} from "../index";
import {getSupabaseClient} from "../supabase";
import {fetchMetrixIdentityByEmail} from "./metrixService";

export type PlayerIdentity = {
    playerId: number
    email: string
    metrixUserId: number
    name: string
}

export const getPlayers = async (env: Env) => {
    const supabase = getSupabaseClient(env)
    return supabase.from('player').select('*').order('name', {ascending: true})
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