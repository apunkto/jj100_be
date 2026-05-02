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
    /** Present after food-choice migration */
    is_vege_food?: boolean;
    pizza?: string | null;
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
    /** Metrix pool starting hole (1-based). Used to order progress circles. */
    startGroup: number | null;
    /** `holeDiffs[i]` = score vs par for course hole `i + 1`, or null if not played yet. */
    holeDiffs: (number | null)[];
    /** Worst vs-par among scored holes; null if none. */
    worstResult:
        | null
        | { kind: 'single'; holeNumber: number; strokes: number | null; diff: number }
        | { kind: 'tied'; count: number; diff: number; strokesWhenUniform: number | null };
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

function orderHoleDiffsForStartGroup(
    holeDiffs: (number | null)[],
    totalHoles: number,
    startGroup: number | null,
): (number | null)[] {
    const n = totalHoles
    if (n <= 0) return []
    let s = startGroup != null && Number.isFinite(startGroup) ? Math.floor(Number(startGroup)) : 1
    if (s < 1 || s > n) s = 1
    const out: (number | null)[] = []
    for (let i = 0; i < n; i++) {
        const courseHole = ((s - 1 + i) % n) + 1
        out.push(holeDiffs[courseHole - 1] ?? null)
    }
    return out
}

function cumulativeParPlayedSeries(ordered: (number | null)[]): { hole: number; toPar: number }[] {
    let cum = 0
    let played = 0
    const out: { hole: number; toPar: number }[] = []
    for (const d of ordered) {
        if (d === null) continue
        cum += d
        played += 1
        out.push({ hole: played, toPar: cum })
    }
    return out
}

function parseHoleStrokes(resultRaw: unknown): number | null {
    const n = parseInt(String(resultRaw ?? '').trim(), 10)
    return Number.isFinite(n) ? n : null
}

function computeWorstHoleResult(
    results: HoleResult[] | null | undefined,
    totalHoles: number,
): PlayerStatsResponse['worstResult'] {
    const arr = results ?? []
    type Entry = { holeNumber: number; diff: number; strokes: number | null }
    const entries: Entry[] = []
    for (let i = 0; i < totalHoles; i++) {
        const raw = arr[i] as HoleResult | HoleResult[] | null | undefined
        if (raw == null || Array.isArray(raw)) continue
        const hole = raw as HoleResult
        if (String(hole.Result ?? '').trim() === '') continue
        const diff = hole.Diff
        if (typeof diff !== 'number' || !Number.isFinite(diff)) continue
        const strokes = parseHoleStrokes(hole.Result)
        entries.push({ holeNumber: i + 1, diff, strokes })
    }
    if (entries.length === 0) return null

    const maxDiff = Math.max(...entries.map((e) => e.diff))
    const tied = entries.filter((e) => e.diff === maxDiff)
    if (tied.length === 1) {
        const e = tied[0]!
        return { kind: 'single', holeNumber: e.holeNumber, strokes: e.strokes, diff: e.diff }
    }
    const strokeValues = tied.map((e) => e.strokes)
    const allHaveStrokes = strokeValues.every((s) => s != null)
    const nums = strokeValues.filter((s): s is number => s != null)
    const uniform =
        allHaveStrokes && nums.length === tied.length && new Set(nums).size === 1 ? nums[0]! : null
    return { kind: 'tied', count: tied.length, diff: maxDiff, strokesWhenUniform: uniform }
}

function buildHoleDiffsFromPlayerResults(
    results: HoleResult[] | null | undefined,
    totalHoles: number
): (number | null)[] {
    const arr = results ?? []
    const out: (number | null)[] = []
    for (let i = 0; i < totalHoles; i++) {
        const raw = arr[i] as HoleResult | HoleResult[] | null | undefined
        if (raw == null || Array.isArray(raw)) {
            out.push(null)
            continue
        }
        const hole = raw as HoleResult
        const result = String(hole.Result ?? '').trim()
        if (result === '') {
            out.push(null)
            continue
        }
        const diff = hole.Diff
        out.push(typeof diff === 'number' && Number.isFinite(diff) ? diff : null)
    }
    return out
}

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

    const holeDiffs = buildHoleDiffsFromPlayerResults(selected.player_results, totalHoles)
    const worstResult = computeWorstHoleResult(selected.player_results, totalHoles)

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
        scoreBreakdown,
        holes: {played: playedHoles, total: totalHoles, playedPct},
        obHoles,
        startGroup: selected.start_group,
        holeDiffs,
        worstResult,
    };

    return {data: response, error: null};
};

export type PoolParProgressPoint = { hole: number; toPar: number }

export type PoolParProgressPlayer = {
    userId: string;
    name: string;
    isSelf: boolean;
    points: PoolParProgressPoint[];
};

export type PoolParProgressResponse = {
    players: PoolParProgressPlayer[];
};

/** Same start_group: cumulative vs par after each scored hole (pool playing order). */
export const getMetrixPoolParProgress = async (
    env: Env,
    userId: string,
    competitionId: number,
): Promise<{ data: PoolParProgressResponse; error: { message: string } | null }> => {
    const myRes = await getPlayerResult(env, competitionId, userId)
    if (myRes.error) return { data: { players: [] }, error: myRes.error }
    const myRow = myRes.data
    if (!myRow) return { data: { players: [] }, error: null }

    const totalHoles = myRow.total_holes ?? 0
    if (totalHoles <= 0) return { data: { players: [] }, error: null }

    const poolStart = myRow.start_group
    const buildForRow = (row: MetrixPlayerResultRow): PoolParProgressPlayer => {
        const holeDiffs = buildHoleDiffsFromPlayerResults(row.player_results, totalHoles)
        const anchor = poolStart != null && Number.isFinite(poolStart) ? poolStart : row.start_group
        const ordered = orderHoleDiffsForStartGroup(holeDiffs, totalHoles, anchor)
        const points = cumulativeParPlayedSeries(ordered)
        return {
            userId: row.user_id,
            name: row.name ?? '',
            isSelf: row.user_id === userId,
            points,
        }
    }

    if (poolStart == null || !Number.isFinite(poolStart)) {
        return {
            data: { players: [buildForRow(myRow)] },
            error: null,
        }
    }

    const supabase = getSupabaseClient(env)
    const { data: rows, error } = await supabase
        .from('metrix_player_result')
        .select('user_id, name, player_results, total_holes, start_group')
        .eq('metrix_competition_id', competitionId)
        .eq('start_group', poolStart)

    if (error) return { data: { players: [] }, error }

    const list = (rows ?? []) as MetrixPlayerResultRow[]
    const players: PoolParProgressPlayer[] = list
        .map((row) => buildForRow(row))
        .sort((a, b) => {
            if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })

    return { data: { players }, error: null }
}

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
    /** Non-DNF only — used for "Lõpetanud … / …st". */
    playerCount: number;
    /** All synced players (includes DNF) — use for lake % denominator. */
    totalPlayersCount: number;
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

    /**
     * "Viimasel puulil": among all non-DNF players (any group), the largest `remaining` holes —
     * i.e. whoever still has the most to play. DNF rows are skipped.
     */
    let mostHolesLeft = 0
    let finishedPlayersCount = 0
    let totalThrows = 0
    let sumDiff = 0
    const nonDnfPlayers: MetrixPlayerResultRow[] = []

    for (const p of players) {
        totalThrows += p.sum ?? 0
        sumDiff += p.diff ?? 0

        if (p.dnf) {
            continue
        }

        nonDnfPlayers.push(p)
        const results = p.player_results ?? []
        const holeCount = results.length

        const played = results.filter(
            (h) => h != null && !Array.isArray(h) && (h.Diff != null && h.Diff !== undefined)
        ).length
        const remaining = Math.max(0, totalHoles - played)
        if (remaining > mostHolesLeft) mostHolesLeft = remaining

        const allPlayed =
            holeCount > 0 &&
            results.every((h) => !Array.isArray(h) || (Array.isArray(h) && h.length !== 0))
        if (allPlayed) finishedPlayersCount++
    }

    const { entries: longestStreaks } = findLongestBirdieStreaks(nonDnfPlayers, totalHoles)
    const longestAces = findLongestAces(nonDnfPlayers, holeMap)

    // Lake: include DNF — they still threw OB before/withdrawing
    const lakePlayersCount = players.filter((p) => (p.water_holes_with_pen ?? 0) > 0).length;
    const averageDiff = players.length > 0 ? sumDiff / players.length : 0;

    return {
        data: {
            /** Denominator for "Lõpetanud … mängijat Xst" — non-DNF only; DNF are not "finished" here. */
            playerCount: nonDnfPlayers.length,
            totalPlayersCount: players.length,
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
