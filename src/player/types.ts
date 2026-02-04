export type PlayerIdentity = {
    playerId: number
    email: string
    metrixUserId: number
    name: string
    activeCompetitionId: number | null
    isAdmin: boolean
}

export type UserParticipation = {
    year: number
    place: number
    score: number
}

export type ParticipationLeaderboard = {
    maxAmount: number
    buckets: Array<{
        amount: number
        players: Array<{ metrixUserId: number; name: string }>
    }>
}

export type UserCompetition = { id: number; name: string | null }
export type UserCompetitionWithDate = { id: number; name: string | null; competition_date: string | null }
