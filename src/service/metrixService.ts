import {getSupabaseClient} from '../supabase';
import type {Env} from '../index';
import {getCachedCompetition} from "./metrixStatsService";

// Types for Metrix API Response
export interface HoleResult {
    Result: string;
    Diff: number;
    PEN: string
}

export interface PlayerResult {
    UserID: string;
    Name: string;
    OrderNumber: number;
    Diff: number;
    ClassName: string;
    Sum: number;
    Dnf?: boolean | null;
    PlayerResults?: HoleResult[];
    Group: string
}

export interface CompetitionElement {
    Results: PlayerResult[];
}

export type MetrixIdentity = {
    userId: number
    name: string
}

interface MetrixAPIResponse {
    Competition: CompetitionElement;
}

export async function fetchMetrixIdentityByEmail(email: string): Promise<MetrixIdentity | null> {
    // return demo user 753 Eivo Kisand:
    if (email.toLowerCase() === 'apunkto@gmail.com') {
        return {userId: 753, name: 'Eivo Kisand'};
    } else return null;
}

export const updateHoleStatsFromMetrix = async (env: Env) => {
    const totalStart = Date.now();
    const supabase = getSupabaseClient(env);
    const url = 'https://discgolfmetrix.com/api.php?content=result&id=' + env.CURRENT_COMPETITION_ID;

    const fetchStart = Date.now();
    const res = await fetch(url);
    const data = (await res.json()) as MetrixAPIResponse;
    const fetchDuration = Date.now() - fetchStart;
    console.log(`[Metrix] Fetch duration: ${fetchDuration}ms`);

    const parseStart = Date.now();
    const holeStats: Record<number, {
        eagles: number;
        birdies: number;
        pars: number;
        bogeys: number;
        double_bogeys: number;
        others: number;
    }> = {};

    const comp = data?.Competition;

    if (comp) {
        const {error: cacheErr} = await supabase
            .from('metrix_result')
            .upsert(
                {
                    competition_id: Number(env.CURRENT_COMPETITION_ID),
                    data: comp.Results,
                    created_date: new Date().toISOString(),
                },
                {onConflict: 'competition_id'}
            );

        if (cacheErr) {
            console.error('[Metrix] Cache upsert failed (raw):', cacheErr);
            console.error('[Metrix] Cache upsert failed (string):', JSON.stringify(cacheErr, null, 2));
            console.error('[Metrix] Cache upsert failed (props):', {
                message: (cacheErr as any).message,
                details: (cacheErr as any).details,
                hint: (cacheErr as any).hint,
                code: (cacheErr as any).code,
            });
        }

        const players = comp.Results || [];
        for (const player of players) {
            const holes = player?.PlayerResults || [];
            for (let i = 0; i < holes.length; i++) {
                const holeIndex = i + 1;
                const diff = holes[i]?.Diff;

                if (!holeStats[holeIndex]) {
                    holeStats[holeIndex] = {
                        eagles: 0,
                        birdies: 0,
                        pars: 0,
                        bogeys: 0,
                        double_bogeys: 0,
                        others: 0
                    };
                }

                if (diff <= -2) holeStats[holeIndex].eagles++;
                else if (diff === -1) holeStats[holeIndex].birdies++;
                else if (diff === 0) holeStats[holeIndex].pars++;
                else if (diff === 1) holeStats[holeIndex].bogeys++;
                else if (diff === 2) holeStats[holeIndex].double_bogeys++;
                else if (diff >= 3) holeStats[holeIndex].others++;
            }
        }
    }
    const parseDuration = Date.now() - parseStart;
    console.log(`[Metrix] Parse & calculation duration: ${parseDuration}ms`);

    const updateStart = Date.now();
    const updates = Object.entries(holeStats).map(([holeNumber, stats]) => ({
        number: Number(holeNumber),
        ...stats
    }));

    const {error} = await supabase
        .from('hole')
        .upsert(updates, {onConflict: 'number'});

    const updateDuration = Date.now() - updateStart;
    const totalDuration = Date.now() - totalStart;

    console.log(`[Metrix] Update duration: ${updateDuration}ms`);
    console.log(`[Metrix] Total duration: ${totalDuration}ms`);

    return {success: !error, updated: updates.length, error};
};

export const getCurrentHole = async (env: Env, userId: number, competitionId: number) => {
    const cached = await getCachedCompetition(env, competitionId)
    if (cached.error) return { data: null, error: cached.error }

    // cached.data!.results is the Results array
    const results = (cached.data?.results ?? []) as any[]

    const player = results.find((p) => p.UserID === String(userId))
    if (!player) return { data: 1, error: null }

    const playerResults: any[] = Array.isArray(player.PlayerResults) ? player.PlayerResults : []
    const totalHoles = playerResults.length

    if (totalHoles <= 0) {
        const g = Number(player.Group)
        return { data: Number.isFinite(g) && g > 0 ? g : 1, error: null }
    }

    const isPlayed = (entry: any): boolean => {
        if (!entry) return false
        if (Array.isArray(entry)) return false // [] means unplayed
        const r = String(entry.Result ?? '').trim()
        return r !== ''
    }

    const playedFlags = playerResults.map(isPlayed)
    const anyPlayed = playedFlags.some(Boolean)

    // If player has not played any holes -> return Group
    if (!anyPlayed) {
        const g = Number(player.Group)
        return { data: Number.isFinite(g) && g > 0 ? g : 1, error: null }
    }

    // Find last played index (by array position)
    let lastPlayedIndex = -1
    for (let i = totalHoles - 1; i >= 0; i--) {
        if (playedFlags[i]) {
            lastPlayedIndex = i
            break
        }
    }

    // Safety fallback
    if (lastPlayedIndex === -1) {
        const g = Number(player.Group)
        return { data: Number.isFinite(g) && g > 0 ? g : 1, error: null }
    }

    // Scan from the next hole, wrapping around, to find the first unplayed hole
    const start = (lastPlayedIndex + 1) % totalHoles
    for (let step = 0; step < totalHoles; step++) {
        const idx = (start + step) % totalHoles
        if (!playedFlags[idx]) {
            return { data: idx + 1, error: null } // hole number is index+1
        }
    }

    // All holes played
    return { data: 1, error: null }
}
