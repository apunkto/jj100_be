import type {Env} from '../shared/types'
import {
    FinalGameParticipant,
    FinalGameParticipantDto,
    getEligibleFinalGameCount,
    getFinalGameParticipants
} from './service'
import {getPuttingGameState, PuttingGameState} from './puttingGame'

const KV_DRAW_PREFIX = 'final_game_draw:'

export type FinalGameDrawStateValue = {
    participantCount: number
    winnerName?: string
    participantNames?: string[]
}

export type FinalGameDrawResponse = {
    finalGameParticipants: { id: number; name: string; order: number; playerId: number }[]
    participantCount: number
    winnerName?: string
    participantNames?: string[]
}


function isDrawPhase(participants: { id: number }[]): boolean {
    return participants.length < 10
}

function drawKvKey(competitionId: number): string {
    return `${KV_DRAW_PREFIX}${competitionId}`
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
        return {finalGameParticipants, participantCount: 10, participantNames: finalGameParticipants.map((p) => p.name)}
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
    return {finalGameParticipants, participantCount, winnerName, participantNames}
}

/** Returns putting-game payload only. Use when participants >= 10 and game started. */
export async function getFinalGamePuttingPayload(
    env: Env, competitionId: number, participants: FinalGameParticipant[]): Promise<PuttingGameState | null> {
    if (participants.length < 10) return null

    const puttingRes = await getPuttingGameState(env, competitionId, {participants})
    const puttingState = puttingRes.state


    if (!puttingState) {
        return {
            status: 'not_started',
            currentLevel: 1,
            currentTurnParticipantId: null,
            currentTurnName: null,
            winnerName: null,
            winnerId: null,
            players: participants
                .sort((a, b) => a.final_game_order - b.final_game_order)
                .map((p) => ({
                    finalParticipantId: p.id,
                    name: p.player.name,
                    order: p.final_game_order,
                    playerId: p.player.id,
                    status: 'active',
                    lastResult: p.last_result,
                    lastLevel: p.last_level,
                } as FinalGameParticipantDto)),
        }
    }


    return puttingState
}

export async function setFinalGameDrawState(
    env: Env,
    competitionId: number,
    value: FinalGameDrawStateValue
): Promise<void> {
    await env.FINAL_GAME_STATE.put(drawKvKey(competitionId), JSON.stringify(value))
}
