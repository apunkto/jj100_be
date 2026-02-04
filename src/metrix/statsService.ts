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
