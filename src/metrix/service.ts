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

// Helpers for updateHoleStatsFromMetrix
function hasOb(hole: HoleResult | undefined): boolean {
    if (hole == null) return false;
    const pen = String(hole.PEN ?? '').trim();
    return pen !== '' && pen !== '0';
}

function isHio(result: unknown): boolean {
    if (result == null) return false;
    const s = String(result).trim();
    return s === '1' || Number(s) === 1;
}

function parseGroup(group: string | undefined): number | null {
    const g = parseInt(String(group ?? ''), 10);
    return Number.isFinite(g) ? g : null;
}

interface HoleStatsEntry {
    eagles: number;
    birdies: number;
    pars: number;
    bogeys: number;
    double_bogeys: number;
    others: number;
    sumDiff: number;
    diffCount: number;
    hioCount: number;
    playersWithPen: Set<string>;
}

function createEmptyHoleStat(): HoleStatsEntry {
    return {
        eagles: 0,
        birdies: 0,
        pars: 0,
        bogeys: 0,
        double_bogeys: 0,
        others: 0,
        sumDiff: 0,
        diffCount: 0,
        hioCount: 0,
        playersWithPen: new Set<string>(),
    };
}

function getOrCreateHoleStat(
    holeStats: Record<number, HoleStatsEntry>,
    holeIndex: number
): HoleStatsEntry {
    if (!holeStats[holeIndex]) {
        holeStats[holeIndex] = createEmptyHoleStat();
    }
    return holeStats[holeIndex];
}

function accumulateHoleStat(
    holeStats: Record<number, HoleStatsEntry>,
    holeIndex: number,
    hole: HoleResult | undefined,
    userId: string,
    pen?: boolean
): void {
    const diff = hole?.Diff;
    const stat = getOrCreateHoleStat(holeStats, holeIndex);

    if (typeof diff === 'number') {
        if (diff <= -2) stat.eagles++;
        else if (diff === -1) stat.birdies++;
        else if (diff === 0) stat.pars++;
        else if (diff === 1) stat.bogeys++;
        else if (diff === 2) stat.double_bogeys++;
        else if (diff >= 3) stat.others++;
        if (Number.isFinite(diff)) {
            stat.sumDiff += diff;
            stat.diffCount += 1;
        }
    }

    if (pen ?? hasOb(hole)) {
        stat.playersWithPen.add(userId);
    }

    if (isHio(hole?.Result)) {
        stat.hioCount += 1;
    }
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
    if (!res.ok) {
        console.error('[Metrix] Fetch failed:', res.status, res.statusText);
        return { success: false, updated: 0, error: new Error(`Metrix API returned ${res.status}`) };
    }
    const data = (await res.json()) as MetrixAPIResponse;
    const fetchDuration = Date.now() - fetchStart;
    console.log(`[Metrix] Fetch duration: ${fetchDuration}ms`);

    const comp = data?.Competition;
    if (!comp) {
        return { success: true, updated: 0, error: null };
    }

    const competitionName = comp.Name ?? null;
    const competitionDate = comp.Date ?? null;

    const {data: compRow} = await supabase
        .from('metrix_competition')
        .upsert(
            {
                metrix_competition_id: metrixCompetitionId,
                name: competitionName,
                competition_date: competitionDate,
                status: 'started',
            },
            { onConflict: 'metrix_competition_id' }
        )
        .select('id')
        .single();

    const competitionId = compRow?.id ?? null;
    if (competitionId == null) {
        console.error('[Metrix] Failed to resolve competition id for', metrixCompetitionId);
        return { success: false, updated: 0, error: null };
    }

    const players = (comp.Results || []).filter((p) => p.UserID != null && p.UserID !== '');
    console.log('players size', players.length);

    const {data: waterHoles} = await supabase
        .from('hole')
        .select('number')
        .eq('metrix_competition_id', competitionId)
        .eq('is_water_hole', true);
    const waterHoleNumbers = new Set(waterHoles?.map((h) => h.number) ?? []);

    const holeStats: Record<number, HoleStatsEntry> = {};
    const now = new Date().toISOString();

    const playerRows = players.map((p) => {
        const holes = p.PlayerResults ?? [];
        const userId = String(p.UserID);
        let waterHolesWithPen = 0;
        let eagles = 0,
            birdies = 0,
            birdieOrBetter = 0,
            pars = 0,
            bogeys = 0,
            doubleBogeys = 0,
            tripleOrWorse = 0;
        let playedHoles = 0,
            obHoles = 0;
        let lastPlayedHoleIndex: number | null = null;

        for (let i = 0; i < holes.length; i++) {
            const holeNumber = i + 1;
            const hole = holes[i];
            const diff = hole?.Diff;
            const result = (hole?.Result ?? '').toString().trim();
            const pen = hasOb(hole);

            if (result !== '') {
                playedHoles++;
                lastPlayedHoleIndex = i;
            }
            if (pen) obHoles++;
            if (typeof diff === 'number') {
                if (diff <= -2) eagles++;
                else if (diff === -1) birdies++;
                else if (diff === 0) pars++;
                else if (diff === 1) bogeys++;
                else if (diff === 2) doubleBogeys++;
                else if (diff >= 3) tripleOrWorse++;
                if (diff <= -1) birdieOrBetter++;
            }
            if (waterHoleNumbers.has(holeNumber) && pen) {
                waterHolesWithPen++;
            }

            accumulateHoleStat(holeStats, holeNumber, hole, userId, pen);
        }

        return {
            metrix_competition_id: competitionId,
            user_id: userId,
            name: p.Name ?? null,
            class_name: p.ClassName ?? null,
            order_number: p.OrderNumber ?? null,
            diff: p.Diff ?? null,
            sum: p.Sum ?? null,
            dnf: Boolean(p.Dnf),
            start_group: parseGroup(p.Group),
            player_results: p.PlayerResults ?? null,
            water_holes_with_pen: waterHolesWithPen,
            birdie_or_better: birdieOrBetter,
            pars,
            bogeys,
            eagles,
            birdies,
            double_bogeys: doubleBogeys,
            triple_or_worse: tripleOrWorse,
            total_holes: holes.length,
            played_holes: playedHoles,
            ob_holes: obHoles,
            last_played_hole_index: lastPlayedHoleIndex,
            updated_date: now,
        };
    });

    const {error: playerErr} = await supabase
        .from('metrix_player_result')
        .upsert(playerRows, { onConflict: 'metrix_competition_id,user_id' });

    if (playerErr) {
        console.error('[Metrix] metrix_player_result upsert failed:', playerErr);
    }

    const entries = Object.entries(holeStats);
    if (entries.length === 0) {
        return { success: true, updated: 0, error: null };
    }

    const holeNumbers = entries.map(([numStr]) => Number(numStr));

    const holeNumbersByAvgDiff = entries.map(([numStr, stats]) => {
        const num = Number(numStr);
        const average_diff = stats.diffCount > 0 ? stats.sumDiff / stats.diffCount : 0;
        return { number: num, average_diff };
    });
    holeNumbersByAvgDiff.sort((a, b) => b.average_diff - a.average_diff);
    const rankByHoleNumber: Record<number, number> = {};
    holeNumbersByAvgDiff.forEach((entry, index) => {
        rankByHoleNumber[entry.number] = index + 1;
    });

    const {data: existingHoles} = await supabase
        .from('hole')
        .select('number')
        .eq('metrix_competition_id', competitionId)
        .in('number', holeNumbers);
    const existingNumbers = new Set((existingHoles ?? []).map((h) => h.number));

    const updates = entries.map(([holeNumber, stats]) => {
        const num = Number(holeNumber);
        const average_diff = stats.diffCount > 0 ? stats.sumDiff / stats.diffCount : 0;
        const playersWithPenCount = stats.playersWithPen.size;
        const ob_percent =
            stats.diffCount > 0 ? (playersWithPenCount / stats.diffCount) * 100 : 0;
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
            players_with_pen: playersWithPenCount,
        };
        if (!existingNumbers.has(num)) {
            row.card_img = 'no_image';
        }
        return row;
    });

    const {error} = await supabase
        .from('hole')
        .upsert(updates, { onConflict: 'metrix_competition_id,number' });

    return { success: !error, updated: updates.length, error };
};

export const getCurrentHole = async (env: Env, userId: number, competitionId: number) => {
    const {data: row, error} = await getPlayerResult(env, competitionId, String(userId))
    if (error) return { data: null, error }
    if (!row) return { data: 1, error: null }

    const totalHoles = row.total_holes ?? 0
    const group = row.start_group
    const groupHole = group != null && Number.isFinite(group) && group > 0 ? group : 1

    if (totalHoles <= 0) {
        return { data: groupHole, error: null }
    }

    const lastIdx = row.last_played_hole_index
    if (lastIdx == null) {
        return { data: groupHole, error: null }
    }

    if (lastIdx + 1 >= totalHoles) {
        return { data: 1, error: null }
    }

    return { data: lastIdx + 2, error: null }
}
