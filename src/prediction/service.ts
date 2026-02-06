import {Env} from '../shared/types'
import {getSupabaseClient} from '../shared/supabase'
import type {
    ActualResults,
    Prediction,
    PredictionData,
    PredictionLeaderboardResponse,
    PredictionWithResults
} from './dto'

// Mock actual results for now
function getMockedActualResults(competitionId: number): ActualResults {
    // Return mocked actual results
    return {
        best_overall_score: -8, // Actual best score was -8
        best_female_score: -3, // Actual best female score was -3
        will_rain: false, // It did not rain
        player_own_score: 8, // Player's own score - mocked value
        hole_in_ones_count: 2, // Actually 2 hole-in-ones occurred
        water_discs_count: 42, // Actually 42 discs were thrown into water
    }
}

export async function getUserPrediction(
    env: Env,
    competitionId: number,
    playerId: number
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

    // Add mocked actual results
    const actualResults = getMockedActualResults(competitionId)
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
    // All fields are optional, but if provided, they should be valid
    // Score fields can be negative (below par) or positive (above par)
    if (data.best_overall_score !== undefined && data.best_overall_score !== null) {
        if (!Number.isFinite(data.best_overall_score)) {
            return {valid: false, error: 'Invalid best overall score'}
        }
    }

    if (data.best_female_score !== undefined && data.best_female_score !== null) {
        if (!Number.isFinite(data.best_female_score)) {
            return {valid: false, error: 'Invalid best female score'}
        }
    }

    if (data.player_own_score !== undefined && data.player_own_score !== null) {
        if (!Number.isFinite(data.player_own_score)) {
            return {valid: false, error: 'Invalid player own score'}
        }
    }

    // Count fields must be non-negative integers
    if (data.hole_in_ones_count !== undefined && data.hole_in_ones_count !== null) {
        if (!Number.isFinite(data.hole_in_ones_count) || data.hole_in_ones_count < 0) {
            return {valid: false, error: 'Invalid hole-in-ones count'}
        }
    }

    if (data.water_discs_count !== undefined && data.water_discs_count !== null) {
        if (!Number.isFinite(data.water_discs_count) || data.water_discs_count < 0) {
            return {valid: false, error: 'Invalid water discs count'}
        }
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

        // Add mocked actual results
        const actualResults = getMockedActualResults(competitionId)
        const predictionWithResults: PredictionWithResults = {
            ...(data as Prediction),
            actual_results: actualResults,
        }

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

        // Add mocked actual results
        const actualResults = getMockedActualResults(competitionId)
        const predictionWithResults: PredictionWithResults = {
            ...(data as Prediction),
            actual_results: actualResults,
        }

        return {data: predictionWithResults, error: null}
    }
}

export async function getPredictionLeaderboard(
    env: Env,
    competitionId: number,
    playerId?: number
): Promise<{ data: PredictionLeaderboardResponse; error: { message: string } | null }> {
    // Mock leaderboard for now - return demo data with top 10
    const allMockData = [
        {player_name: 'Mängija 1', score: 95, rank: 1},
        {player_name: 'Mängija 2', score: 87, rank: 2},
        {player_name: 'Mängija 3', score: 82, rank: 3},
        {player_name: 'Mängija 4', score: 78, rank: 4},
        {player_name: 'Mängija 5', score: 75, rank: 5},
        {player_name: 'Mängija 6', score: 72, rank: 6},
        {player_name: 'Mängija 7', score: 68, rank: 7},
        {player_name: 'Mängija 8', score: 65, rank: 8},
        {player_name: 'Mängija 9', score: 62, rank: 9},
        {player_name: 'Mängija 10', score: 60, rank: 10},
        {player_name: 'Mängija 11', score: 58, rank: 11},
        {player_name: 'Mängija 12', score: 55, rank: 12},
    ]

    const top10 = allMockData.slice(0, 10)

    // If playerId is provided, check if user has a prediction and get their rank
    let userRank: {player_name: string; score: number; rank: number} | null = null
    if (playerId !== undefined) {
        const userPrediction = await getUserPrediction(env, competitionId, playerId)
        if (userPrediction.data) {
            // Get player name from database
            const supabase = getSupabaseClient(env)
            const {data: player} = await supabase
                .from('player')
                .select('name')
                .eq('id', playerId)
                .maybeSingle()

            const playerName = player?.name || 'Sina'

            // For mock data, check if user is in top 10
            // If user has a prediction, assign them rank 15 (not in top 10) for demo
            // In real implementation, this would calculate based on actual scores
            const userRankValue = 15
            const userScore = 50

            const userInTop10 = top10.find((entry) => entry.rank === userRankValue)
            if (!userInTop10) {
                // User is not in top 10, return their rank separately
                userRank = {player_name: playerName, score: userScore, rank: userRankValue}
            } else {
                // User is in top 10, mark them in the top 10 list
                // Find the entry and update it with user's name
                const userEntryIndex = top10.findIndex((entry) => entry.rank === userRankValue)
                if (userEntryIndex !== -1) {
                    top10[userEntryIndex].player_name = playerName
                }
            }
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
