import {Env} from '../shared/types'
import {getSupabaseClient} from '../shared/supabase'
import type {
    ActualResults,
    Prediction,
    PredictionData,
    PredictionLeaderboardResponse,
    PredictionWithResults
} from './dto'
import {precomputePredictionResults} from './precompute'

// Scoring helper functions
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

// Calculate actual results from metrix_player_result table
export async function calculateActualResults(
    env: Env,
    competitionId: number,
    playerId?: number,
    metrixUserId?: number
): Promise<ActualResults> {
    const supabase = getSupabaseClient(env)

    // Get player's metrix_user_id if needed (only if not already provided)
    let userId: number | undefined = metrixUserId
    if (playerId !== undefined && userId === undefined) {
        const {data: playerData} = await supabase
            .from('player')
            .select('metrix_user_id')
            .eq('id', playerId)
            .maybeSingle()
        userId = playerData?.metrix_user_id ? Number(playerData.metrix_user_id) : undefined
    }

    // Single query to get all relevant rows - filter by competition, dnf=false, and diff IS NOT NULL
    // This is more efficient than multiple queries, especially with proper indexes
    const {data: results, error} = await supabase
        .from('metrix_player_result')
        .select('diff, class_name, user_id')
        .eq('metrix_competition_id', competitionId)
        .eq('dnf', false)
        .not('diff', 'is', null)

    if (error) {
        // Query failed: return nulls for all derived data; try did_rain from competition
        const {data: competitionData} = await supabase
            .from('metrix_competition')
            .select('did_rain')
            .eq('id', competitionId)
            .maybeSingle()

        return {
            best_overall_score: null,
            best_female_score: null,
            will_rain: competitionData?.did_rain ?? false,
            player_own_score: null,
            hole_in_ones_count: null,
            water_discs_count: null,
        }
    }

    // Process results in memory (much faster than multiple DB round trips)
    let best_overall_score: number | null = null
    let best_female_score: number | null = null
    let player_own_score: number | null = null

    const femaleClasses = ['Peened Preilid', 'Soliidsed Daamid']
    const userIdStr = userId !== undefined ? String(userId) : null
    
    for (const row of results || []) {
        if (row.diff === null || row.diff === undefined) continue
        
        // Best overall score (minimum diff)
        if (best_overall_score === null || row.diff < best_overall_score) {
            best_overall_score = row.diff
        }
        
        // Best female score (minimum diff for female classes)
        if (row.class_name && femaleClasses.includes(row.class_name)) {
            if (best_female_score === null || row.diff < best_female_score) {
                best_female_score = row.diff
            }
        }
        
        // Player's own score
        if (userIdStr && row.user_id === userIdStr) {
            player_own_score = row.diff
        }
    }

    // Query for HIO count - sum hio_count from hole table
    const {data: hioData, error: hioError} = await supabase
        .from('hole')
        .select('hio_count')
        .eq('metrix_competition_id', competitionId)

    const hole_in_ones_count = hioError || !hioData 
        ? null 
        : hioData.reduce((sum, h) => sum + (h.hio_count || 0), 0)

    // Count players who threw OB in at least one water hole
    const {count: water_discs_count, error: waterError} = await supabase
        .from('metrix_player_result')
        .select('*', {count: 'exact', head: true})
        .eq('metrix_competition_id', competitionId)
        .eq('dnf', false)
        .gt('water_holes_with_pen', 0)

    const water_discs_count_result = waterError ? null : (water_discs_count ?? null)

    // Get did_rain from metrix_competition table
    const {data: competitionData, error: competitionError} = await supabase
        .from('metrix_competition')
        .select('did_rain')
        .eq('id', competitionId)
        .maybeSingle()

    const will_rain = competitionError || !competitionData 
        ? false 
        : (competitionData.did_rain ?? false)

    return {
        best_overall_score,
        best_female_score,
        will_rain,
        player_own_score,
        hole_in_ones_count,
        water_discs_count: water_discs_count_result,
    }
}

export async function getUserPrediction(
    env: Env,
    competitionId: number,
    playerId: number,
    metrixUserId?: number
): Promise<{ data: PredictionWithResults | null; error: { message: string } | null }> {
    const supabase = getSupabaseClient(env)

    const {data, error} = await supabase
        .from('predictions')
        .select('*')
        .eq('metrix_competition_id', competitionId)
        .eq('player_id', playerId)
        .maybeSingle()

    if (error) {
        return {data: null, error: {message: error.message}}
    }

    if (!data) {
        return {data: null, error: null}
    }

    // Always use precomputed data
    const [actualResultsData, playerScoreData] = await Promise.all([
        supabase
            .from('prediction_actual_results')
            .select('*')
            .eq('metrix_competition_id', competitionId)
            .maybeSingle(),
        supabase
            .from('prediction_scores')
            .select('player_own_score')
            .eq('metrix_competition_id', competitionId)
            .eq('player_id', playerId)
            .maybeSingle(),
    ])

    let actualResults: ActualResults

    // Use precomputed data if available
    if (!actualResultsData.error && actualResultsData.data) {
        actualResults = {
            best_overall_score: actualResultsData.data.best_overall_score,
            best_female_score: actualResultsData.data.best_female_score,
            will_rain: actualResultsData.data.will_rain,
            player_own_score: playerScoreData.data?.player_own_score ?? null,
            hole_in_ones_count: actualResultsData.data.hole_in_ones_count,
            water_discs_count: actualResultsData.data.water_discs_count,
        }
    } else {
        // Return null values if precomputed data doesn't exist
        actualResults = {
            best_overall_score: null,
            best_female_score: null,
            will_rain: false,
            player_own_score: null,
            hole_in_ones_count: null,
            water_discs_count: null,
        }
    }

    const predictionWithResults: PredictionWithResults = {
        ...(data as Prediction),
        actual_results: actualResults,
    }

    return {data: predictionWithResults, error: null}
}

export async function checkPredictionEnabled(
    env: Env,
    competitionId: number
): Promise<{ enabled: boolean; error: { message: string } | null }> {
    const supabase = getSupabaseClient(env)

    const {data, error} = await supabase
        .from('metrix_competition')
        .select('prediction_enabled')
        .eq('id', competitionId)
        .maybeSingle()

    if (error) {
        return {enabled: false, error: {message: error.message}}
    }

    if (!data) {
        return {enabled: false, error: {message: 'Competition not found'}}
    }

    return {enabled: data.prediction_enabled, error: null}
}

export function validatePredictionData(data: PredictionData): { valid: boolean; error?: string } {
    // All fields are mandatory
    // Score fields can be negative (below par) or positive (above par)
    if (data.best_overall_score === undefined || data.best_overall_score === null) {
        return {valid: false, error: 'Best overall score is required'}
    }
    if (!Number.isFinite(data.best_overall_score)) {
        return {valid: false, error: 'Invalid best overall score'}
    }

    if (data.best_female_score === undefined || data.best_female_score === null) {
        return {valid: false, error: 'Best female score is required'}
    }
    if (!Number.isFinite(data.best_female_score)) {
        return {valid: false, error: 'Invalid best female score'}
    }

    if (data.player_own_score === undefined || data.player_own_score === null) {
        return {valid: false, error: 'Player own score is required'}
    }
    if (!Number.isFinite(data.player_own_score)) {
        return {valid: false, error: 'Invalid player own score'}
    }

    // Count fields must be non-negative integers
    if (data.hole_in_ones_count === undefined || data.hole_in_ones_count === null) {
        return {valid: false, error: 'Hole-in-ones count is required'}
    }
    if (!Number.isFinite(data.hole_in_ones_count) || data.hole_in_ones_count < 0) {
        return {valid: false, error: 'Invalid hole-in-ones count'}
    }

    if (data.water_discs_count === undefined || data.water_discs_count === null) {
        return {valid: false, error: 'Water discs count is required'}
    }
    if (!Number.isFinite(data.water_discs_count) || data.water_discs_count < 0) {
        return {valid: false, error: 'Invalid water discs count'}
    }

    // Boolean field must be provided
    if (data.will_rain === undefined || data.will_rain === null) {
        return {valid: false, error: 'Will rain prediction is required'}
    }
    if (typeof data.will_rain !== 'boolean') {
        return {valid: false, error: 'Invalid will rain prediction'}
    }

    return {valid: true}
}

export async function createOrUpdatePrediction(
    env: Env,
    competitionId: number,
    playerId: number,
    predictionData: PredictionData
): Promise<{ data: PredictionWithResults | null; error: { message: string } | null }> {
    const supabase = getSupabaseClient(env)

    // Check if prediction is enabled
    const enabledCheck = await checkPredictionEnabled(env, competitionId)
    if (enabledCheck.error || !enabledCheck.enabled) {
        return {data: null, error: {message: 'Prediction is not enabled for this competition'}}
    }

    // Validate data
    const validation = validatePredictionData(predictionData)
    if (!validation.valid) {
        return {data: null, error: {message: validation.error || 'Invalid prediction data'}}
    }

    // Check if prediction already exists
    const existing = await getUserPrediction(env, competitionId, playerId)
    if (existing.error) {
        return {data: null, error: existing.error}
    }

    const now = new Date().toISOString()

    if (existing.data) {
        // Update existing prediction
        const {data, error} = await supabase
            .from('predictions')
            .update({
                ...predictionData,
                updated_date: now,
            })
            .eq('id', existing.data.id)
            .select()
            .maybeSingle()

        if (error) {
            return {data: null, error: {message: error.message}}
        }

        // Calculate actual results from database
        const actualResults = await calculateActualResults(env, competitionId, playerId)
        const predictionWithResults: PredictionWithResults = {
            ...(data as Prediction),
            actual_results: actualResults,
        }

        // Trigger recalculation for this competition (async, don't wait)
        precomputePredictionResults(env, competitionId).catch((err) => {
            console.error(`Failed to precompute prediction results for competition ${competitionId}:`, err)
        })

        return {data: predictionWithResults, error: null}
    } else {
        // Create new prediction
        const {data, error} = await supabase
            .from('predictions')
            .insert([
                {
                    metrix_competition_id: competitionId,
                    player_id: playerId,
                    ...predictionData,
                    created_date: now,
                    updated_date: now,
                },
            ])
            .select()
            .maybeSingle()

        if (error) {
            return {data: null, error: {message: error.message}}
        }

        // Calculate actual results from database
        const actualResults = await calculateActualResults(env, competitionId, playerId)
        const predictionWithResults: PredictionWithResults = {
            ...(data as Prediction),
            actual_results: actualResults,
        }

        // Trigger recalculation for this competition (async, don't wait)
        precomputePredictionResults(env, competitionId).catch((err) => {
            console.error(`Failed to precompute prediction results for competition ${competitionId}:`, err)
        })

        return {data: predictionWithResults, error: null}
    }
}

export async function getPredictionLeaderboard(
    env: Env,
    competitionId: number,
    playerId?: number
): Promise<{ data: PredictionLeaderboardResponse; error: { message: string } | null }> {
    const supabase = getSupabaseClient(env)

    // Always use precomputed data
    const {data: precomputedScores, error: scoresError} = await supabase
        .from('prediction_scores')
        .select('player_id, total_score, rank, updated_at')
        .eq('metrix_competition_id', competitionId)
        .order('total_score', {ascending: false})

    // Use precomputed data if available
    if (!scoresError && precomputedScores && precomputedScores.length > 0) {
        const playerIds = precomputedScores.map((s) => s.player_id)
        const {data: players, error: playersError} = await supabase
            .from('player')
            .select('id, name')
            .in('id', playerIds)

        if (playersError) {
            return {data: {top_10: [], user_rank: null}, error: {message: playersError.message}}
        }

        const playerMap = new Map<number, string>()
        if (players) {
            for (const player of players) {
                playerMap.set(player.id, player.name)
            }
        }

        // Build leaderboard entries from precomputed data
        const leaderboardEntries: Array<{
            player_name: string
            player_id: number
            score: number
            rank: number
        }> = precomputedScores.map((s) => ({
            player_name: playerMap.get(s.player_id) || 'Tundmatu mängija',
            player_id: s.player_id,
            score: s.total_score,
            rank: s.rank || 0,
        }))

        // Get top 10
        const top10 = leaderboardEntries.slice(0, 10)

        // Find user's rank if playerId is provided
        let userRank: {player_name: string; player_id: number; score: number; rank: number} | null = null
        if (playerId !== undefined) {
            const userEntry = leaderboardEntries.find((entry) => entry.player_id === playerId)
            if (userEntry) {
                userRank = userEntry
            }
        }

        return {
            data: {
                top_10: top10,
                user_rank: userRank,
            },
            error: null,
        }
    }

    // Return empty leaderboard if precomputed data doesn't exist
    return {data: {top_10: [], user_rank: null}, error: null}
}
