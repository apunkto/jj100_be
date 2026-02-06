export type PredictionData = {
    best_overall_score?: number | null
    best_female_score?: number | null
    will_rain?: boolean | null
    player_own_score?: number | null
    hole_in_ones_count?: number | null
    water_discs_count?: number | null
}

export type Prediction = {
    id: number
    metrix_competition_id: number
    player_id: number
    best_overall_score: number | null
    best_female_score: number | null
    will_rain: boolean | null
    player_own_score: number | null
    hole_in_ones_count: number | null
    water_discs_count: number | null
    created_date: string
    updated_date: string
}

export type ActualResults = {
    best_overall_score: number | null
    best_female_score: number | null
    will_rain: boolean | null
    player_own_score: number | null
    hole_in_ones_count: number | null
    water_discs_count: number | null
}

export type PredictionWithResults = Prediction & {
    actual_results: ActualResults
}

export type PredictionLeaderboardEntry = {
    player_name: string
    player_id?: number
    score: number
    rank: number
}

export type PredictionLeaderboardResponse = {
    top_10: PredictionLeaderboardEntry[]
    user_rank: PredictionLeaderboardEntry | null
}
