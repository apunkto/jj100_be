import {getSupabaseClient} from '../shared/supabase';
import type {Env} from '../shared/types';
import {getPlayerResult} from "./statsService";

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
    Name?: string;
    Date?: string; // e.g. "2026-02-07"
    Results: PlayerResult[];
}

export type MetrixIdentity = {
    userId: number
    name: string
}

const METRIX_IDENTITIES_CACHE_NAME = 'metrix-identities-cache'
const CACHE_TTL_SECONDS = 120 // 2 minutes

function getCacheKeyForEmail(email: string): Request {
    const normalizedEmail = email.trim().toLowerCase()
    return new Request(`https://cache.local/metrix-identities/${encodeURIComponent(normalizedEmail)}`, {method: 'GET'})
}

export async function cacheMetrixIdentities(email: string, identities: MetrixIdentity[]): Promise<void> {
    const cache = await caches.open(METRIX_IDENTITIES_CACHE_NAME)
    const cacheKey = getCacheKeyForEmail(email)
    const response = new Response(JSON.stringify(identities), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `max-age=${CACHE_TTL_SECONDS}`,
        },
    })
    await cache.put(cacheKey, response)
}

export async function getCachedMetrixIdentities(email: string): Promise<MetrixIdentity[] | null> {
    const cache = await caches.open(METRIX_IDENTITIES_CACHE_NAME)
    const cacheKey = getCacheKeyForEmail(email)
    const cached = await cache.match(cacheKey)
    
    if (!cached) return null
    
    try {
        return await cached.json() as MetrixIdentity[]
    } catch {
        return null
    }
}

interface MetrixAPIResponse {
    Competition: CompetitionElement;
}

export async function fetchMetrixIdentityByEmail(email: string): Promise<MetrixIdentity[]> {
    // demo: return list of identities for apunkto@gmail.com
    if (email.toLowerCase() === 'apunkto@gmail.com') {
        return [
            { userId: 753, name: 'Eivo Kisand' },
            { userId: 228, name: 'Anti Orgla' },
        ];
    }
    return [];
}

export const updateHoleStatsFromMetrix = async (env: Env, metrixCompetitionId: number) => {
    const supabase = getSupabaseClient(env);
    const url = 'https://discgolfmetrix.com/api.php?content=result&id=' + metrixCompetitionId;

    const fetchStart = Date.now();
    const res = await fetch(url);
    const data = (await res.json()) as MetrixAPIResponse;
    const fetchDuration = Date.now() - fetchStart;
    console.log(`[Metrix] Fetch duration: ${fetchDuration}ms`);

    const holeStats: Record<number, {
        eagles: number;
        birdies: number;
        pars: number;
        bogeys: number;
        double_bogeys: number;
        others: number;
        sumDiff: number;
        diffCount: number;
        obPlayerCount: number; // players who had at least one OB (PEN non-zero) on this hole
        hioCount: number; // count of hole-in-ones (Result === "1")
        playersWithPen: Set<string>; // unique players who had PEN > 0 on this hole
    }> = {};
    let competitionId: number | null = null;

    const comp = data?.Competition;

    if (comp) {
        const competitionName = comp.Name ?? null;
        const competitionDate = comp.Date ?? null;
        const {data: existingComp} = await supabase
            .from('metrix_competition')
            .select('id')
            .eq('metrix_competition_id', metrixCompetitionId)
            .maybeSingle();
        if (!existingComp) {
            await supabase.from('metrix_competition').insert({
                metrix_competition_id: metrixCompetitionId,
                name: competitionName,
                competition_date: competitionDate,
                status: 'started',
            });
        } else {
            const updates: { name?: string; competition_date?: string | null } = {};
            if (competitionName != null) updates.name = competitionName;
            if (competitionDate != null) updates.competition_date = competitionDate;
            if (Object.keys(updates).length > 0) {
                await supabase
                    .from('metrix_competition')
                    .update(updates)
                    .eq('metrix_competition_id', metrixCompetitionId);
            }
        }

        const {data: compRow} = await supabase
            .from('metrix_competition')
            .select('id')
            .eq('metrix_competition_id', metrixCompetitionId)
            .single();
        competitionId = compRow?.id ?? null;
        if (competitionId == null) {
            console.error('[Metrix] Failed to resolve competition id for', metrixCompetitionId);
        }

        const players = (comp.Results || []).filter((p) => p.UserID != null && p.UserID !== '');
        console.log('players size', players.length);

        // Get water hole numbers for this competition (for calculating water_holes_with_pen)
        const {data: waterHoles} = await supabase
            .from('hole')
            .select('number')
            .eq('metrix_competition_id', competitionId)
            .eq('is_water_hole', true)
        const waterHoleNumbers = new Set(waterHoles?.map(h => h.number) || [])

        const now = new Date().toISOString();
        const playerRows = players.map((p) => {
            const holes = p.PlayerResults || []
            let waterHolesWithPen = 0

            // Count water holes where this player had PEN > 0
            for (let i = 0; i < holes.length; i++) {
                const holeNumber = i + 1 // Convert to 1-based hole number
                if (waterHoleNumbers.has(holeNumber)) {
                    const pen = holes[i]?.PEN
                    const hasOb = pen != null && String(pen).trim() !== '' && String(pen).trim() !== '0'
                    if (hasOb) {
                        waterHolesWithPen++
                    }
                }
            }

            return {
                metrix_competition_id: competitionId,
                user_id: String(p.UserID),
                name: p.Name ?? null,
                class_name: p.ClassName ?? null,
                order_number: p.OrderNumber ?? null,
                diff: p.Diff ?? null,
                sum: p.Sum ?? null,
                dnf: Boolean(p.Dnf),
                start_group: (() => {
                    const g = parseInt(p.Group, 10);
                    return Number.isFinite(g) ? g : null;
                })(),
                player_results: p.PlayerResults ?? null,
                water_holes_with_pen: waterHolesWithPen,
                updated_date: now,
            }
        });

        const {error: playerErr} = await supabase
            .from('metrix_player_result')
            .upsert(playerRows, {onConflict: 'metrix_competition_id,user_id'});

        if (playerErr) {
            console.error('[Metrix] metrix_player_result upsert failed:', playerErr);
        }

        for (const player of players) {
            const holes = player?.PlayerResults || [];
            const userId = String(player.UserID);
            for (let i = 0; i < holes.length; i++) {
                const holeIndex = i + 1;
                const diff = holes[i]?.Diff;
                const pen = holes[i]?.PEN;
                const result = holes[i]?.Result;

                if (!holeStats[holeIndex]) {
                    holeStats[holeIndex] = {
                        eagles: 0,
                        birdies: 0,
                        pars: 0,
                        bogeys: 0,
                        double_bogeys: 0,
                        others: 0,
                        sumDiff: 0,
                        diffCount: 0,
                        obPlayerCount: 0,
                        hioCount: 0,
                        playersWithPen: new Set<string>(),
                    };
                }

                if (diff <= -2) holeStats[holeIndex].eagles++;
                else if (diff === -1) holeStats[holeIndex].birdies++;
                else if (diff === 0) holeStats[holeIndex].pars++;
                else if (diff === 1) holeStats[holeIndex].bogeys++;
                else if (diff === 2) holeStats[holeIndex].double_bogeys++;
                else if (diff >= 3) holeStats[holeIndex].others++;

                if (typeof diff === 'number' && Number.isFinite(diff)) {
                    holeStats[holeIndex].sumDiff += diff;
                    holeStats[holeIndex].diffCount += 1;
                }

                // PEN non-zero = player threw at least once into OB on this hole
                const hasOb = pen != null && String(pen).trim() !== '' && String(pen).trim() !== '0';
                if (hasOb) {
                    holeStats[holeIndex].obPlayerCount += 1;
                    holeStats[holeIndex].playersWithPen.add(userId);
                }

                // HIO detection: Result === "1" or Number(Result) === 1
                if (result != null) {
                    const resultStr = String(result).trim();
                    if (resultStr === "1" || Number(resultStr) === 1) {
                        holeStats[holeIndex].hioCount += 1;
                    }
                }
            }
        }
    }

    // Average diff from par (negative = easier, positive = harder) and rank (biggest diff = rank 1)
    const holeNumbersByAvgDiff: { number: number; average_diff: number }[] = [];
    for (const [numStr, stats] of Object.entries(holeStats)) {
        const num = Number(numStr);
        const avg = stats.diffCount > 0 ? stats.sumDiff / stats.diffCount : 0;
        holeNumbersByAvgDiff.push({ number: num, average_diff: avg });
    }
    holeNumbersByAvgDiff.sort((a, b) => b.average_diff - a.average_diff);
    const rankByHoleNumber: Record<number, number> = {};
    holeNumbersByAvgDiff.forEach((entry, index) => {
        rankByHoleNumber[entry.number] = index + 1;
    });

    let holeResult = { success: true as boolean, updated: 0, error: null as any };
    if (comp && competitionId != null && Object.keys(holeStats).length > 0) {
        const holeNumbers = Object.keys(holeStats).map(Number);
        const {data: existingHoles} = await supabase
            .from('hole')
            .select('number')
            .eq('metrix_competition_id', competitionId)
            .in('number', holeNumbers);
        const existingNumbers = new Set((existingHoles ?? []).map((h) => h.number));

        const updates = Object.entries(holeStats).map(([holeNumber, stats]) => {
            const num = Number(holeNumber);
            const average_diff = stats.diffCount > 0 ? stats.sumDiff / stats.diffCount : 0;
            const ob_percent = stats.diffCount > 0
                ? (stats.obPlayerCount / stats.diffCount) * 100
                : 0;
            const row: Record<string, unknown> = {
                metrix_competition_id: competitionId,
                number: num,
                eagles: stats.eagles,
                birdies: stats.birdies,
                pars: stats.pars,
                bogeys: stats.bogeys,
                double_bogeys: stats.double_bogeys,
                others: stats.others,
                average_diff,
                rank: rankByHoleNumber[num] ?? 0,
                ob_percent,
                hio_count: stats.hioCount,
                players_with_pen: stats.playersWithPen.size,
            };
            if (!existingNumbers.has(num)) {
                row.card_img = 'no_image';
            }
            return row;
        });


        const {error} = await supabase
            .from('hole')
            .upsert(updates, {onConflict: 'metrix_competition_id,number'});

        holeResult = { success: !error, updated: updates.length, error };
    }

    return holeResult;
};

export const getCurrentHole = async (env: Env, userId: number, competitionId: number) => {
    const {data: row, error} = await getPlayerResult(env, competitionId, String(userId))
    if (error) return { data: null, error }
    if (!row) return { data: 1, error: null }

    const playerResults: any[] = Array.isArray(row.player_results) ? row.player_results : []
    const totalHoles = playerResults.length
    const group = row.start_group
    const groupHole = group != null && Number.isFinite(group) && group > 0 ? group : 1

    if (totalHoles <= 0) {
        return { data: groupHole, error: null }
    }

    const isPlayed = (entry: any): boolean => {
        if (!entry) return false
        if (Array.isArray(entry)) return false
        const r = String(entry.Result ?? '').trim()
        return r !== ''
    }

    const playedFlags = playerResults.map(isPlayed)
    const anyPlayed = playedFlags.some(Boolean)

    if (!anyPlayed) {
        return { data: groupHole, error: null }
    }

    let lastPlayedIndex = -1
    for (let i = totalHoles - 1; i >= 0; i--) {
        if (playedFlags[i]) {
            lastPlayedIndex = i
            break
        }
    }

    if (lastPlayedIndex === -1) {
        return { data: groupHole, error: null }
    }

    const start = (lastPlayedIndex + 1) % totalHoles
    for (let step = 0; step < totalHoles; step++) {
        const idx = (start + step) % totalHoles
        if (!playedFlags[idx]) {
            return { data: idx + 1, error: null }
        }
    }

    return { data: 1, error: null }
}
