import {getSupabaseClient} from '../supabase'
import type {Env} from '../index'
import {CompetitionElement, PlayerResult} from "./metrixService";


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
};

const getCachedCompetition = async (env: Env, competitionId: number) => {
    const supabase = getSupabaseClient(env);

    const {data, error} = await supabase
        .from('metrix_result')
        .select('data, created_date')
        .eq('competition_id', competitionId)
        .maybeSingle();

    if (error) return {data: null, error};
    if (!data) return {data: null, error: {message: 'No cached metrix_result for competition'}};

    // data.data is jsonb -> already an object
    return {data: {results: data.data as PlayerResult[], cachedAt: data.created_date as string}, error: null};
};

export const getMetrixPlayers = async (env: Env, competitionId?: number) => {
    const id = competitionId ?? Number(env.CURRENT_COMPETITION_ID);
    const cached = await getCachedCompetition(env, id);
    if (cached.error) return {data: null, error: cached.error};

    const players = cached.data.results ?? [];
    // keep it small for FE list
    const list = players.map(p => ({
        userId: p.UserID,
        name: p.Name,
        className: p.ClassName,
        diff: p.Diff,
        orderNumber: p.OrderNumber,
        dnf: p.Dnf === true,
    }));

    return {data: {competitionId: id, cachedAt: cached.data!.cachedAt, players: list}, error: null};
};

export const getMetrixPlayerStats = async (env: Env, userId: string, competitionId?: number) => {
    const id = competitionId ?? Number(env.CURRENT_COMPETITION_ID);
    const cached = await getCachedCompetition(env, id);
    if (cached.error) return {data: null, error: cached.error};

    const results = cached.data!.results ?? [];
    console.log('results', results);
    const selected = results.find(p => p.UserID === userId);

    if (!selected) {
        return {data: null, error: {message: `Player ${userId} not found in cached competition ${id}`}};
    }

    // delta to class leader
    const sameClass = results.filter(p => p.ClassName === selected.ClassName && p.Dnf !== true);
    const leader = sameClass.length
        ? sameClass.reduce((min, p) => (p.Diff < min.Diff ? p : min))
        : null;
    const deltaToClassLeader = leader ? (selected.Diff - leader.Diff) : null;

    // overall place (exclude DNF)
    const validPlayers = results.filter(p => p.Dnf !== true);
    const sorted = [...validPlayers].sort((a, b) => a.Diff - b.Diff);
    const index = sorted.findIndex(p => p.UserID === selected.UserID);
    const overallPlace = index >= 0 ? index + 1 : null;

    // score breakdown
    let scoreBreakdown: PlayerStatsResponse['scoreBreakdown'] = null;
    if (selected.PlayerResults?.length) {
        let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubleBogeys = 0, tripleOrWorse = 0;

        for (const hole of selected.PlayerResults) {
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

    const response: PlayerStatsResponse = {
        competitionId: id,
        cachedAt: cached.data!.cachedAt,
        player: {
            userId: selected.UserID,
            name: selected.Name,
            className: selected.ClassName,
            orderNumber: selected.OrderNumber,
            diff: selected.Diff,
            sum: selected.Sum,
            dnf: selected.Dnf === true,
        },
        deltaToClassLeader,
        overallPlace,
        scoreBreakdown,
    };

    return {data: response, error: null};
};
