import {getSupabaseClient} from '../shared/supabase'
import type {Env} from '../shared/types'
import type {HoleResult} from "./service";

type HoleResultEl = HoleResult | HoleResult[] | null

/** Find longest birdie-or-better streaks across all players. */
function findLongestBirdieStreaks(
    players: Array<{ name: string | null; player_results?: HoleResultEl[] | null }>,
    totalHoles: number
): { count: number; entries: { count: number; player: string; startHole: number; endHole: number }[] } {
    let bestStreakCount = 0
    const longestStreaks: { count: number; player: string; startHole: number; endHole: number }[] = []

    for (const p of players) {
        const results = p.player_results ?? []
        const holeCount = results.length
        if (holeCount === 0) continue

        for (let i = 0; i < holeCount; i++) {
            let streak = 0
            while (streak < holeCount) {
                const idx = (i + streak) % holeCount
                const hr = results[idx]
                if (!hr || Array.isArray(hr)) break
                const diff = (hr as HoleResult).Diff
                if (diff == null || diff >= 0) break
                streak++
            }
            if (streak > bestStreakCount) {
                bestStreakCount = streak
                longestStreaks.length = 0
                longestStreaks.push({
                    count: streak,
                    player: p.name ?? '',
                    startHole: (i % holeCount) + 1,
                    endHole: ((i + streak - 1) % holeCount) + 1,
                })
            } else if (streak === bestStreakCount && streak > 0) {
                longestStreaks.push({
                    count: streak,
                    player: p.name ?? '',
                    startHole: (i % holeCount) + 1,
                    endHole: ((i + streak - 1) % holeCount) + 1,
                })
            }
        }
    }
    return { count: bestStreakCount, entries: longestStreaks }
}

/** Find longest ace (hole-in-one) by hole length. */
function findLongestAces(
    players: Array<{ name: string | null; player_results?: HoleResultEl[] | null }>,
    holeMap: Record<number, number>
): { player: string; holeNumber: number; length: number }[] {
    let maxAceLength = 0
    const longestAces: { player: string; holeNumber: number; length: number }[] = []

    for (const p of players) {
        const results = p.player_results ?? []
        results.forEach((hr, idx) => {
            if (!hr || Array.isArray(hr)) return
            const resultNum = parseInt(String((hr as HoleResult).Result ?? ''), 10)
            if (!isNaN(resultNum) && resultNum === 1) {
                const holeNum = idx + 1
                const length = holeMap[holeNum] ?? 0
                if (length > maxAceLength) {
                    maxAceLength = length
                    longestAces.length = 0
                    longestAces.push({ player: p.name ?? '', holeNumber: holeNum, length })
                } else if (length === maxAceLength) {
                    longestAces.push({ player: p.name ?? '', holeNumber: holeNum, length })
                }
            }
        })
    }
    return longestAces
}

export type MetrixPlayerResultRow = {
    id: number;
    metrix_competition_id: number;
    user_id: string;
    name: string | null;
    class_name: string | null;
    order_number: number | null;
    diff: number | null;
    sum: number | null;
    dnf: boolean;
    start_group: number | null;
    player_results: HoleResult[] | null;
    updated_date: string;
    water_holes_with_pen: number;
    birdie_or_better: number;
    pars: number;
    bogeys: number;
    eagles: number;
    birdies: number;
    double_bogeys: number;
    triple_or_worse: number;
    total_holes: number;
    played_holes: number;
    ob_holes: number;
    last_played_hole_index: number | null;
};

export type PlayerStatsResponse = {
    competitionId: number;
    cachedAt: string;
    player: {
        userId: string;
        name: string;
        className: string;
        orderNumber: number;
        diff: number;
        sum: number;
        dnf: boolean;
    };
    deltaToClassLeader: number | null;
    overallPlace: number | null;
    scoreBreakdown: {
        eagles: number;
        birdies: number;
        pars: number;
        bogeys: number;
        doubleBogeys: number;
        tripleOrWorse: number;
    } | null;
    holes: { played: number; total: number; playedPct: number | null };
    obHoles: number;
};

export const isCompetitionParticipant = async (
    env: Env,
    competitionId: number,
    metrixUserId: number | string
): Promise<{ data: boolean; error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env);
    const userIdStr = String(metrixUserId);
    const {data, error} = await supabase
        .from('metrix_player_result')
        .select('user_id')
        .eq('metrix_competition_id', competitionId)
        .eq('user_id', userIdStr)
        .maybeSingle();
    if (error) return {data: false, error};
    return {data: !!data, error: null};
};

export const getPlayerResult = async (
    env: Env,
    competitionId: number,
    userId: string
): Promise<{ data: MetrixPlayerResultRow | null; error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env);
    const {data, error} = await supabase
        .from('metrix_player_result')
        .select('*')
        .eq('metrix_competition_id', competitionId)
        .eq('user_id', userId)
        .maybeSingle();
    if (error) return {data: null, error};
    return {data: data as MetrixPlayerResultRow | null, error: null};
};

export const getAllPlayerRankingFields = async (
    env: Env,
    competitionId: number
): Promise<{ data: { user_id: string; diff: number | null; class_name: string | null; dnf: boolean }[]; error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env);
    const {data, error} = await supabase
        .from('metrix_player_result')
        .select('user_id, diff, class_name, dnf')
        .eq('metrix_competition_id', competitionId);
    if (error) return {data: [], error};
    return {data: (data ?? []) as { user_id: string; diff: number | null; class_name: string | null; dnf: boolean }[], error: null};
};



export const getMetrixPlayerStats = async (env: Env, userId: string, competitionId: number) => {
    const playerResult = await getPlayerResult(env, competitionId, userId);
    if (playerResult.error) return {data: null, error: playerResult.error};
    const selected = playerResult.data;
    if (!selected) return {data: null, error: null};

    const ranking = await getAllPlayerRankingFields(env, competitionId);
    const results = ranking.data ?? [];

    const sameClass = results.filter(p => p.class_name === selected.class_name && !p.dnf);
    const leader = sameClass.length
        ? sameClass.reduce((min, p) => ((min.diff ?? 999999) < (p.diff ?? 999999) ? min : p))
        : null;
    const deltaToClassLeader = leader && selected.diff != null
        ? selected.diff - (leader.diff ?? 0)
        : null;

    const validPlayers = results.filter(p => !p.dnf);
    const sorted = [...validPlayers].sort((a, b) => (a.diff ?? 999999) - (b.diff ?? 999999));
    const index = sorted.findIndex(p => p.user_id === selected.user_id);
    const overallPlace = index >= 0 ? index + 1 : null;

    // score breakdown and hole counts (from persisted columns)
    const totalHoles = selected.total_holes ?? 0;
    const playedHoles = selected.played_holes ?? 0;
    const obHoles = selected.ob_holes ?? 0;
    const playedPct = totalHoles > 0 ? (playedHoles / totalHoles) * 100 : null;

    const scoreBreakdown: PlayerStatsResponse['scoreBreakdown'] = totalHoles > 0
        ? {
            eagles: selected.eagles,
            birdies: selected.birdies,
            pars: selected.pars,
            bogeys: selected.bogeys,
            doubleBogeys: selected.double_bogeys,
            tripleOrWorse: selected.triple_or_worse,
        }
        : null;

    const response: PlayerStatsResponse = {
        competitionId,
        cachedAt: selected.updated_date,
        player: {
            userId: selected.user_id,
            name: selected.name ?? "",
            className: selected.class_name ?? "",
            orderNumber: selected.order_number ?? 0,
            diff: selected.diff ?? 0,
            sum: selected.sum ?? 0,
            dnf: selected.dnf,
        },
        deltaToClassLeader,
        overallPlace,
        scoreBreakdown,
        holes: {played: playedHoles, total: totalHoles, playedPct},
        obHoles,
    };

    return {data: response, error: null};
};

// Dashboard: PlayerResult shape for frontend (matches Metrix API)
export type DashboardPlayerResult = {
    UserID: number;
    Name: string;
    OrderNumber: number;
    Diff: number;
    ClassName: string;
    Sum: number;
    DNF?: boolean | null;
    PlayerResults?: { Diff: number; Result: string; PEN?: string }[];
};

export type TopPlayersByDivisionResponse = {
    topPlayersByDivision: Record<string, DashboardPlayerResult[]>;
};

function toDashboardPlayerResult(row: {
    user_id: string;
    name: string | null;
    class_name: string | null;
    order_number: number | null;
    diff: number | null;
    sum: number | null;
    dnf: boolean;
    player_results?: HoleResult[] | null;
}): DashboardPlayerResult {
    return {
        UserID: parseInt(row.user_id, 10) || 0,
        Name: row.name ?? '',
        OrderNumber: row.order_number ?? 0,
        Diff: row.diff ?? 0,
        ClassName: row.class_name ?? '',
        Sum: row.sum ?? 0,
        DNF: row.dnf,
        PlayerResults: row.player_results ?? undefined,
    };
}

export const getTopPlayersByDivision = async (
    env: Env,
    competitionId: number
): Promise<{ data: TopPlayersByDivisionResponse | null; error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env);
    const { data: rows, error } = await supabase
        .from('metrix_player_result')
        .select('user_id, name, class_name, order_number, diff, sum, dnf, player_results')
        .eq('metrix_competition_id', competitionId)
        .eq('dnf', false)
        .not('order_number', 'is', null)
        .lte('order_number', 10)
        .order('class_name')
        .order('order_number');

    if (error) return { data: null, error };
    const list = (rows ?? []) as { user_id: string; name: string | null; class_name: string | null; order_number: number | null; diff: number | null; sum: number | null; dnf: boolean; player_results: HoleResult[] | null }[];

    const topPlayersByDivision: Record<string, DashboardPlayerResult[]> = {};
    for (const row of list) {
        const div = row.class_name ?? '';
        if (!topPlayersByDivision[div]) topPlayersByDivision[div] = [];
        topPlayersByDivision[div].push(toDashboardPlayerResult(row));
    }

    return { data: { topPlayersByDivision }, error: null };
};

export type MyDivisionResultResponse = {
    place: number;
    player: DashboardPlayerResult;
} | null;

export const getMyDivisionResult = async (
    env: Env,
    competitionId: number,
    metrixUserId: number
): Promise<{ data: MyDivisionResultResponse; error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env);
    const { data: row, error } = await supabase
        .from('metrix_player_result')
        .select('user_id, name, class_name, order_number, diff, sum, dnf, player_results')
        .eq('metrix_competition_id', competitionId)
        .eq('user_id', String(metrixUserId))
        .eq('dnf', false)
        .maybeSingle();

    if (error) return { data: null, error };
    if (!row) return { data: null, error: null };
    const place = Number(row.order_number) || 0;
    const player = toDashboardPlayerResult(row);
    return { data: { place, player }, error: null };
};

export type CompetitionStatsResponse = {
    playerCount: number;
    mostHolesLeft: number;
    finishedPlayersCount: number;
    totalThrows: number;
    averageDiff: number;
    lakeOBCount: number;
    lakePlayersCount: number;
    totalHoles: number;
    longestStreaks: { count: number; player: string; startHole: number; endHole: number }[];
    longestAces: { player: string; holeNumber: number; length: number }[];
};

export const getCompetitionStats = async (
    env: Env,
    competitionId: number
): Promise<{ data: CompetitionStatsResponse | null; error: { message: string } | null }> => {
    const supabase = getSupabaseClient(env);

    const { data: playerRows, error: playerErr } = await supabase
        .from('metrix_player_result')
        .select('*')
        .eq('metrix_competition_id', competitionId);

    if (playerErr) return { data: null, error: playerErr };
    const players = (playerRows ?? []) as MetrixPlayerResultRow[];

    const { data: holeRows, error: holeErr } = await supabase
        .from('hole')
        .select('number, length')
        .eq('metrix_competition_id', competitionId);

    if (holeErr) return { data: null, error: holeErr };
    const totalHoles = (holeRows ?? []).length;
    const holeMap: Record<number, number> = {};
    for (const h of holeRows ?? []) {
        holeMap[h.number] = h.length ?? 0;
    }

    let mostHolesLeft = 0
    let finishedPlayersCount = 0
    let totalThrows = 0
    let sumDiff = 0
    const nonDnfPlayers: MetrixPlayerResultRow[] = []

    for (const p of players) {
        totalThrows += p.sum ?? 0
        sumDiff += p.diff ?? 0

        if (p.dnf) {
            finishedPlayersCount++
            continue
        }

        nonDnfPlayers.push(p)
        const results = p.player_results ?? []
        const holeCount = results.length

        const played = results.filter(
            (h) => h != null && !Array.isArray(h) && (h.Diff != null && h.Diff !== undefined)
        ).length
        const remaining = totalHoles - played
        if (remaining > mostHolesLeft) mostHolesLeft = remaining

        const allPlayed =
            holeCount > 0 &&
            results.every((h) => !Array.isArray(h) || (Array.isArray(h) && h.length !== 0))
        if (allPlayed) finishedPlayersCount++
    }

    const { entries: longestStreaks } = findLongestBirdieStreaks(nonDnfPlayers, totalHoles)
    const longestAces = findLongestAces(nonDnfPlayers, holeMap)

    // Count players who threw OB in at least one water hole
    const lakePlayersCount = players.filter(p => !p.dnf && (p.water_holes_with_pen ?? 0) > 0).length;
    const averageDiff = players.length > 0 ? sumDiff / players.length : 0;

    return {
        data: {
            playerCount: players.length,
            mostHolesLeft,
            finishedPlayersCount,
            totalThrows,
            averageDiff,
            lakeOBCount: lakePlayersCount,
            lakePlayersCount,
            totalHoles,
            longestStreaks,
            longestAces,
        },
        error: null,
    };
};
