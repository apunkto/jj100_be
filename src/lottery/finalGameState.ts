import type { Env } from '../shared/types'
import { getFinalGameParticipants, getEligibleFinalGameCount } from './service'
import { getPuttingGameState } from './puttingGame'

const KV_DRAW_PREFIX = 'final_game_draw:'

export type FinalGameDrawStateValue = {
    participantCount: number
    winnerName?: string
    participantNames?: string[]
}

export type PuttingGamePayload = {
    gameStatus: 'not_started' | 'running' | 'finished'
    currentLevel: number
    currentTurnParticipantId: number | null
    currentTurnName: string | null
    winnerName: string | null
    players: { id: number; order: number; name: string; status: 'active' | 'out'; lastLevel: number; lastResult: 'in' | 'out' | null }[]
}

export type FinalGameDrawResponse = {
    finalGameParticipants: { id: number; name: string; order: number; playerId: number }[]
    participantCount: number
    winnerName?: string
    participantNames?: string[]
}

export type FinalGamePuttingResponse = {
    puttingGame: PuttingGamePayload
}

export type FinalGameStateResponse = FinalGameDrawResponse | FinalGamePuttingResponse

function isDrawPhase(participants: { id: number }[]): boolean {
    return participants.length < 10
}

function drawKvKey(competitionId: number): string {
    return `${KV_DRAW_PREFIX}${competitionId}`
}

export async function getFinalGameState(env: Env, competitionId: number): Promise<FinalGameStateResponse> {
    const participantsRes = await getFinalGameParticipants(env, competitionId)
    const participants = participantsRes.data ?? []
    const finalGameParticipants = participants.map((p) => ({
        id: p.id,
        name: p.player.name,
        order: p.final_game_order,
        playerId: p.player.id,
    }))

    if (isDrawPhase(participants)) {
        const [participantCount, raw] = await Promise.all([
            getEligibleFinalGameCount(env, competitionId),
            env.FINAL_GAME_STATE.get(drawKvKey(competitionId)),
        ])
        let winnerName: string | undefined
        let participantNames: string[] | undefined
        if (raw) {
            try {
                const value = JSON.parse(raw) as FinalGameDrawStateValue
                winnerName = value.winnerName
                participantNames = value.participantNames
            } catch {
                // ignore
            }
        }
        return {
            finalGameParticipants,
            participantCount,
            winnerName,
            participantNames,
        }
    }

    const puttingRes = await getPuttingGameState(env, competitionId)
    const puttingState = puttingRes.state
    if (!puttingState) {
        return {
            puttingGame: {
                gameStatus: 'not_started',
                currentLevel: 1,
                currentTurnParticipantId: null,
                currentTurnName: null,
                winnerName: null,
                players: finalGameParticipants
                    .sort((a, b) => a.order - b.order)
                    .map((p) => ({
                        id: p.id,
                        order: p.order,
                        name: p.name,
                        status: 'active' as const,
                        lastLevel: 0,
                        lastResult: null as 'in' | 'out' | null,
                    })),
            },
        }
    }

    const puttingGame: PuttingGamePayload = {
        gameStatus: puttingState.status,
        currentLevel: puttingState.currentLevel,
        currentTurnParticipantId: puttingState.currentTurnFinalGameId,
        currentTurnName: puttingState.currentTurnName,
        winnerName: puttingState.winnerName,
        players: puttingState.players.map((p) => ({
            id: p.finalGameId,
            order: p.order,
            name: p.name,
            status: p.status,
            lastLevel: p.lastLevel,
            lastResult: p.lastResult,
        })),
    }

    return { puttingGame }
}

/** Returns draw-phase state only. Use when participants < 10. */
export async function getFinalGameDrawState(env: Env, competitionId: number): Promise<FinalGameDrawResponse> {
    const participantsRes = await getFinalGameParticipants(env, competitionId)
    const participants = participantsRes.data ?? []
    const finalGameParticipants = participants.map((p) => ({
        id: p.id,
        name: p.player.name,
        order: p.final_game_order,
        playerId: p.player.id,
    }))

    if (!isDrawPhase(participants)) {
        return { finalGameParticipants, participantCount: 10, participantNames: finalGameParticipants.map((p) => p.name) }
    }

    const [participantCount, raw] = await Promise.all([
        getEligibleFinalGameCount(env, competitionId),
        env.FINAL_GAME_STATE.get(drawKvKey(competitionId)),
    ])
    let winnerName: string | undefined
    let participantNames: string[] | undefined
    if (raw) {
        try {
            const value = JSON.parse(raw) as FinalGameDrawStateValue
            winnerName = value.winnerName
            participantNames = value.participantNames
        } catch {
            // ignore
        }
    }
    return { finalGameParticipants, participantCount, winnerName, participantNames }
}

/** Returns putting-game payload only. Use when participants >= 10 and game started. */
export async function getFinalGamePuttingPayload(
    env: Env,
    competitionId: number
): Promise<FinalGamePuttingResponse | null> {
    const participantsRes = await getFinalGameParticipants(env, competitionId)
    const participants = participantsRes.data ?? []
    if (participants.length < 10) return null

    const puttingRes = await getPuttingGameState(env, competitionId)
    const puttingState = puttingRes.state
    const finalGameParticipants = participants.map((p) => ({
        id: p.id,
        name: p.player.name,
        order: p.final_game_order,
        playerId: p.player.id,
    }))

    if (!puttingState) {
        return {
            puttingGame: {
                gameStatus: 'not_started',
                currentLevel: 1,
                currentTurnParticipantId: null,
                currentTurnName: null,
                winnerName: null,
                players: finalGameParticipants
                    .sort((a, b) => a.order - b.order)
                    .map((p) => ({
                        id: p.id,
                        order: p.order,
                        name: p.name,
                        status: 'active' as const,
                        lastLevel: 0,
                        lastResult: null as 'in' | 'out' | null,
                    })),
            },
        }
    }

    const puttingGame: PuttingGamePayload = {
        gameStatus: puttingState.status,
        currentLevel: puttingState.currentLevel,
        currentTurnParticipantId: puttingState.currentTurnFinalGameId,
        currentTurnName: puttingState.currentTurnName,
        winnerName: puttingState.winnerName,
        players: puttingState.players.map((p) => ({
            id: p.finalGameId,
            order: p.order,
            name: p.name,
            status: p.status,
            lastLevel: p.lastLevel,
            lastResult: p.lastResult,
        })),
    }
    return { puttingGame }
}

export async function setFinalGameDrawState(
    env: Env,
    competitionId: number,
    value: FinalGameDrawStateValue
): Promise<void> {
    await env.FINAL_GAME_STATE.put(drawKvKey(competitionId), JSON.stringify(value))
}
