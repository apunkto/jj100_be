import {getSupabaseClient} from '../shared/supabase'
import type {Env} from '../shared/types'
import type {HoleResult} from "./service";

export type MetrixPlayerResultRow = {
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



export const getMetrixPlayerStats = async (env: Env, userId: string, competitionId?: number) => {
    const id = competitionId ?? Number(env.CURRENT_COMPETITION_ID);
    const playerResult = await getPlayerResult(env, id, userId);
    if (playerResult.error) return {data: null, error: playerResult.error};
    const selected = playerResult.data;
    if (!selected) return {data: null, error: null};

    const ranking = await getAllPlayerRankingFields(env, id);
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

    // score breakdown
    let scoreBreakdown: PlayerStatsResponse['scoreBreakdown'] = null;
    const holes = selected.player_results ?? [];
    if (holes.length) {
        let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubleBogeys = 0, tripleOrWorse = 0;

        for (const hole of holes) {
            const diff = hole.Diff;
            if (diff <= -2) eagles++;
            else if (diff === -1) birdies++;
            else if (diff === 0) pars++;
            else if (diff === 1) bogeys++;
            else if (diff === 2) doubleBogeys++;
            else if (diff >= 3) tripleOrWorse++;
        }

        scoreBreakdown = {eagles, birdies, pars, bogeys, doubleBogeys, tripleOrWorse};
    }

    const totalHoles = holes.length

    const playedHoles = holes.reduce((acc, h) => {
        // adjust if your API uses different "not played" markers
        const r = (h.Result ?? "").trim()
        return acc + (r !== "" ? 1 : 0)
    }, 0)

    const playedPct = totalHoles > 0 ? (playedHoles / totalHoles) * 100 : null

    //OB holes
    const obHoles = holes.filter(h => {
        const pen = Number(String(h.PEN ?? "0").replace(",", "."))
        return Number.isFinite(pen) && pen > 0
    }).length

    const response: PlayerStatsResponse = {
        competitionId: id,
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

function countScoreTypes(player: MetrixPlayerResultRow): { birdieOrBetter: number; pars: number; bogeys: number } {
    let birdieOrBetter = 0, pars = 0, bogeys = 0;
    for (const hole of player.player_results ?? []) {
        const diff = hole.Diff;
        if (diff <= -1) birdieOrBetter++;
        else if (diff === 0) pars++;
        else if (diff === 1) bogeys++;
    }
    return { birdieOrBetter, pars, bogeys };
}

function toDashboardPlayerResult(row: MetrixPlayerResultRow): DashboardPlayerResult {
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
        .select('*')
        .eq('metrix_competition_id', competitionId);

    if (error) return { data: null, error };
    const players = (rows ?? []) as MetrixPlayerResultRow[];

    const grouped: Record<string, MetrixPlayerResultRow[]> = {};
    for (const p of players) {
        if (p.dnf) continue;
        const div = p.class_name ?? '';
        if (!grouped[div]) grouped[div] = [];
        grouped[div].push(p);
    }

    const topPlayersByDivision: Record<string, DashboardPlayerResult[]> = {};
    for (const [division, list] of Object.entries(grouped)) {
        list.sort((a, b) => {
            const aDiff = a.diff ?? 0;
            const bDiff = b.diff ?? 0;
            if (aDiff !== bDiff) return aDiff - bDiff;
            const aStats = countScoreTypes(a);
            const bStats = countScoreTypes(b);
            if (aStats.birdieOrBetter !== bStats.birdieOrBetter) return bStats.birdieOrBetter - aStats.birdieOrBetter;
            if (aStats.pars !== bStats.pars) return bStats.pars - aStats.pars;
            if (aStats.bogeys !== bStats.bogeys) return bStats.bogeys - aStats.bogeys;
            return 0;
        });
        topPlayersByDivision[division] = list.slice(0, 8).map(toDashboardPlayerResult);
    }

    return { data: { topPlayersByDivision }, error: null };
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

    let mostHolesLeft = 0;
    let finishedPlayersCount = 0;
    let totalThrows = 0;
    let sumDiff = 0;

    let bestStreakCount = 0;
    const longestStreaks: { count: number; player: string; startHole: number; endHole: number }[] = [];

    let maxAceLength = 0;
    const longestAces: { player: string; holeNumber: number; length: number }[] = [];

    for (const p of players) {
        totalThrows += p.sum ?? 0;
        sumDiff += p.diff ?? 0;

        if (p.dnf) {
            finishedPlayersCount++;
            continue;
        }

        const results = p.player_results ?? [];
        const holeCount = results.length;

        const played = results.filter((h) => h != null && !Array.isArray(h) && (h.Diff !== null && h.Diff !== undefined)).length;
        const remaining = totalHoles - played;
        if (remaining > mostHolesLeft) mostHolesLeft = remaining;

        const allPlayed = holeCount > 0 && results.every((h) => !Array.isArray(h) || (Array.isArray(h) && h.length !== 0));
        if (allPlayed) finishedPlayersCount++;

        for (let i = 0; i < holeCount; i++) {
            let streak = 0;
            while (streak < holeCount) {
                const idx = (i + streak) % holeCount;
                const hr = results[idx];
                if (!hr || Array.isArray(hr)) break;
                if (hr.Diff >= 0) break;
                streak++;
            }
            if (streak > bestStreakCount) {
                bestStreakCount = streak;
                longestStreaks.length = 0;
                longestStreaks.push({
                    count: streak,
                    player: p.name ?? '',
                    startHole: (i % holeCount) + 1,
                    endHole: ((i + streak - 1) % holeCount) + 1,
                });
            } else if (streak === bestStreakCount && streak > 0) {
                longestStreaks.push({
                    count: streak,
                    player: p.name ?? '',
                    startHole: (i % holeCount) + 1,
                    endHole: ((i + streak - 1) % holeCount) + 1,
                });
            }
        }

        results.forEach((hr, idx) => {
            if (!hr || Array.isArray(hr)) return;
            const resultNum = parseInt(String(hr.Result ?? ''), 10);
            if (!isNaN(resultNum) && resultNum === 1) {
                const holeNum = idx + 1;
                const length = holeMap[holeNum] ?? 0;
                if (length > maxAceLength) {
                    maxAceLength = length;
                    longestAces.length = 0;
                    longestAces.push({ player: p.name ?? '', holeNumber: holeNum, length });
                } else if (length === maxAceLength) {
                    longestAces.push({ player: p.name ?? '', holeNumber: holeNum, length });
                }
            }
        });
    }

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
