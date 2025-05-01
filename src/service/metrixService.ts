import { getSupabaseClient } from '../supabase';
import type { Env } from '../index';

// Types for Metrix API Response
interface HoleResult {
    Result: string;
    Diff: number;
}

interface PlayerResult {
    Name: string;
    PlayerResults: HoleResult[];
}

interface CompetitionElement {
    Results: PlayerResult[];
}

interface MetrixAPIResponse {
    Competition: {
        Elements: CompetitionElement[];
    };
}

export const updateHoleStatsFromMetrix = async (env: Env) => {
    const supabase = getSupabaseClient(env);
    const url = 'https://discgolfmetrix.com/api.php?content=result&id=2834664';

    const res = await fetch(url);
    const data = (await res.json()) as MetrixAPIResponse;

    const holeStats: Record<number, {
        eagles: number;
        birdies: number;
        pars: number;
        bogeys: number;
        double: number;
        triple_plus: number;
    }> = {};

    const competitions = data?.Competition?.Elements || [];

    for (const comp of competitions) {
        const players = comp?.Results || [];
        for (const player of players) {
            const holes = player?.PlayerResults || [];
            for (let i = 0; i < holes.length; i++) {
                const holeIndex = i + 1;
                const diff = Number(holes[i]?.Diff);

                if (!holeStats[holeIndex]) {
                    holeStats[holeIndex] = {
                        eagles: 0,
                        birdies: 0,
                        pars: 0,
                        bogeys: 0,
                        double: 0,
                        triple_plus: 0
                    };
                }

                if (diff <= -2) holeStats[holeIndex].eagles++;
                else if (diff === -1) holeStats[holeIndex].birdies++;
                else if (diff === 0) holeStats[holeIndex].pars++;
                else if (diff === 1) holeStats[holeIndex].bogeys++;
                else if (diff === 2) holeStats[holeIndex].double++;
                else if (diff >= 3) holeStats[holeIndex].triple_plus++;
            }
        }
    }

    for (const [holeNumber, stats] of Object.entries(holeStats)) {
        await supabase
            .from('hole')
            .update({
                eagles: stats.eagles,
                birdies: stats.birdies,
                pars: stats.pars,
                bogeys: stats.bogeys,
                double: stats.double,
                triple_plus: stats.triple_plus
            })
            .eq('number', holeNumber);
    }

    return { success: true, updated: Object.keys(holeStats).length };
};
