import {Env} from '../shared/types'
import {getSupabaseClient} from '../shared/supabase'
import type {Prediction} from './dto'
import {calculateActualResults} from './service'

// Scoring helper functions (same as in service.ts)
function calculatePredictionScore(
    predicted: number | null,
    actual: number | null,
    baseScore: number = 100
): number {
    if (predicted === null || predicted === undefined) return 0
    const actualValue = actual ?? 0 // Treat null as 0
    return baseScore - Math.abs(actualValue - predicted)
}

function calculateBooleanPredictionScore(
    predicted: boolean | null,
    actual: boolean | null
): number {
    if (predicted === null || predicted === undefined) return 0
    if (actual === null || actual === undefined) return 0 // No actual data yet
    return predicted === actual ? 15 : 0
}

// Get player's own score from metrix_player_result
async function getPlayerOwnScore(
    env: Env,
    competitionId: number,
    metrixUserId: number
): Promise<number | null> {
    const supabase = getSupabaseClient(env)
    const userIdStr = String(metrixUserId)
    
    const {data: playerResult, error} = await supabase
        .from('metrix_player_result')
        .select('diff')
        .eq('metrix_competition_id', competitionId)
        .eq('user_id', userIdStr)
        .maybeSingle()

    if (error || !playerResult) {
        return null
    }

    return playerResult.diff ?? null
}

// Precompute prediction results for a single competition
export async function precomputePredictionResults(
    env: Env,
    competitionId: number
): Promise<{success: boolean; error?: string; predictionsProcessed?: number}> {
    const supabase = getSupabaseClient(env)

    try {
        // 1. Calculate actual results from metrix_player_result table
        const actualResults = await calculateActualResults(env, competitionId)

        // 2. Upsert into prediction_actual_results table
        const {error: upsertError} = await supabase
            .from('prediction_actual_results')
            .upsert({
                metrix_competition_id: competitionId,
                best_overall_score: actualResults.best_overall_score,
                best_female_score: actualResults.best_female_score,
                will_rain: actualResults.will_rain,
                hole_in_ones_count: actualResults.hole_in_ones_count,
                water_discs_count: actualResults.water_discs_count,
                updated_at: new Date().toISOString(),
            }, {
                onConflict: 'metrix_competition_id',
            })

        if (upsertError) {
            return {success: false, error: `Failed to upsert actual results: ${upsertError.message}`}
        }

        // 3. Fetch all predictions for the competition
        const {data: predictions, error: predictionsError} = await supabase
            .from('predictions')
            .select('*')
            .eq('metrix_competition_id', competitionId)

        if (predictionsError) {
            return {success: false, error: `Failed to fetch predictions: ${predictionsError.message}`}
        }

        if (!predictions || predictions.length === 0) {
            // No predictions, but actual results were saved - that's fine
            return {success: true, predictionsProcessed: 0}
        }

        // 4. Get all player IDs and fetch their metrix_user_ids in one query
        const playerIds = predictions.map((p) => p.player_id)
        const {data: players, error: playersError} = await supabase
            .from('player')
            .select('id, metrix_user_id')
            .in('id', playerIds)

        if (playersError) {
            return {success: false, error: `Failed to fetch players: ${playersError.message}`}
        }

        const playerMap = new Map<number, number>()
        if (players) {
            for (const player of players) {
                playerMap.set(player.id, player.metrix_user_id)
            }
        }

        // 5. Calculate scores for each prediction
        const scoredPredictions: Array<{
            metrix_competition_id: number
            player_id: number
            player_own_score: number | null
            best_overall_score_points: number
            best_female_score_points: number
            player_own_score_points: number
            will_rain_points: number
            hole_in_ones_count_points: number
            water_discs_count_points: number
            total_score: number
        }> = []

        for (const prediction of predictions as Prediction[]) {
            const metrixUserId = playerMap.get(prediction.player_id)
            if (!metrixUserId) {
                // Skip if player not found
                continue
            }

            // Get player's own score
            const playerOwnScore = await getPlayerOwnScore(env, competitionId, metrixUserId)

            // Calculate individual field scores
            const bestOverallScorePoints = calculatePredictionScore(
                prediction.best_overall_score,
                actualResults.best_overall_score
            )
            const bestFemaleScorePoints = calculatePredictionScore(
                prediction.best_female_score,
                actualResults.best_female_score
            )
            const playerOwnScorePoints = calculatePredictionScore(
                prediction.player_own_score,
                playerOwnScore
            )
            const willRainPoints = calculateBooleanPredictionScore(
                prediction.will_rain,
                actualResults.will_rain
            )
            const holeInOnesPoints = calculatePredictionScore(
                prediction.hole_in_ones_count,
                actualResults.hole_in_ones_count,
                100 // baseScore = 100 for HIO
            )
            const waterDiscsPoints = calculatePredictionScore(
                prediction.water_discs_count,
                actualResults.water_discs_count,
                400 // baseScore = 400 for water throwers
            )

            // Total score is sum of all scored fields
            const totalScore = bestOverallScorePoints + bestFemaleScorePoints + playerOwnScorePoints + willRainPoints + holeInOnesPoints + waterDiscsPoints

            scoredPredictions.push({
                metrix_competition_id: competitionId,
                player_id: prediction.player_id,
                player_own_score: playerOwnScore,
                best_overall_score_points: bestOverallScorePoints,
                best_female_score_points: bestFemaleScorePoints,
                player_own_score_points: playerOwnScorePoints,
                will_rain_points: willRainPoints,
                hole_in_ones_count_points: holeInOnesPoints,
                water_discs_count_points: waterDiscsPoints,
                total_score: totalScore,
            })
        }

        // 6. Sort by total score descending and assign ranks
        scoredPredictions.sort((a, b) => b.total_score - a.total_score)
        const scoredWithRanks = scoredPredictions.map((sp, index) => ({
            ...sp,
            rank: index + 1,
            updated_at: new Date().toISOString(),
        }))

        // 7. Upsert all scores into prediction_scores table
        // First, delete existing scores for this competition to handle deleted predictions
        const {error: deleteError} = await supabase
            .from('prediction_scores')
            .delete()
            .eq('metrix_competition_id', competitionId)

        if (deleteError) {
            return {success: false, error: `Failed to delete old scores: ${deleteError.message}`}
        }

        // Then insert new scores
        if (scoredWithRanks.length > 0) {
            const {error: insertError} = await supabase
                .from('prediction_scores')
                .insert(scoredWithRanks)

            if (insertError) {
                return {success: false, error: `Failed to insert scores: ${insertError.message}`}
            }
        }

        return {success: true, predictionsProcessed: scoredWithRanks.length}
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {success: false, error: `Unexpected error: ${message}`}
    }
}

// Entry point for cron job - processes all active competitions
export async function runPredictionPrecompute(
    env: Env
): Promise<{error?: string; results: Array<{competitionId: number; success: boolean; error?: string; predictionsProcessed?: number}>}> {
    const supabase = getSupabaseClient(env)

    // Fetch all competitions where prediction_enabled = true and status IN ('started', 'waiting')
    const {data: competitions, error: fetchErr} = await supabase
        .from('metrix_competition')
        .select('id')
        .eq('prediction_enabled', true)
        .in('status', ['started', 'waiting'])

    if (fetchErr) {
        return {error: fetchErr.message, results: []}
    }

    const results: Array<{competitionId: number; success: boolean; error?: string; predictionsProcessed?: number}> = []

    for (const competition of competitions || []) {
        const result = await precomputePredictionResults(env, competition.id)
        results.push({
            competitionId: competition.id,
            success: result.success,
            error: result.error,
            predictionsProcessed: result.predictionsProcessed,
        })
    }

    return {results}
}
