import type { Env } from '../shared/types'
import { getSupabaseClient } from '../shared/supabase'
import { getFinalGameParticipants } from './service'
import type { FinalGameParticipant } from './service'

export type PuttingGameState = {
    status: 'not_started' | 'running' | 'finished'
    currentLevel: number
    currentTurnFinalGameId: number | null
    currentTurnName: string | null
    winnerFinalGameId: number | null
    winnerName: string | null
    players: {
        finalGameId: number
        order: number
        name: string
        status: 'active' | 'out'
        lastLevel: number
        lastResult: 'in' | 'out' | null
    }[]
}

type StateRow = {
    id: number
    metrix_competition_id: number
    status: string
    current_level: number
    current_turn_final_game_participant_id: number | null
    winner_final_game_participant_id: number | null
}

async function getGameState(env: Env, competitionId: number): Promise<{ state: StateRow | null; error: string | null }> {
    const supabase = getSupabaseClient(env)
    const { data, error } = await supabase
        .from('final_game_state')
        .select('id, metrix_competition_id, status, current_level, current_turn_final_game_participant_id, winner_final_game_participant_id')
        .eq('metrix_competition_id', competitionId)
        .maybeSingle()
    if (error) return { state: null, error: error.message }
    return { state: data as StateRow | null, error: null }
}

function getNextActiveInOrder(
    ordered: FinalGameParticipant[],
    currentId: number,
    isActive: (p: FinalGameParticipant) => boolean
): FinalGameParticipant | null {
    const idx = ordered.findIndex((p) => p.id === currentId)
    if (idx < 0) return null
    for (let i = idx + 1; i < ordered.length; i++) {
        const p = ordered[i]!
        if (isActive(p)) return p
    }
    for (let i = 0; i < idx; i++) {
        const p = ordered[i]!
        if (isActive(p)) return p
    }
    return null
}

export async function getPuttingGameState(env: Env, competitionId: number): Promise<{
    state: PuttingGameState | null
    error: string | null
}> {
    const { state: gameState, error: stateErr } = await getGameState(env, competitionId)
    if (stateErr) return { state: null, error: stateErr }

    const { data: participants, error: partErr } = await getFinalGameParticipants(env, competitionId)
    if (partErr || !participants) return { state: null, error: (partErr as { message?: string } | null)?.message ?? 'No participants' }

    const ordered = [...participants].sort((a, b) => a.final_game_order - b.final_game_order)
    const nameById = new Map(participants.map((p) => [p.id, p.player.name]))

    if (!gameState) {
        return {
            state: {
                status: 'not_started',
                currentLevel: 1,
                currentTurnFinalGameId: null,
                currentTurnName: null,
                winnerFinalGameId: null,
                winnerName: null,
                players: ordered.map((p) => ({
                    finalGameId: p.id,
                    order: p.final_game_order,
                    name: p.player.name,
                    status: 'active' as const,
                    lastLevel: p.last_level,
                    lastResult: p.last_result,
                })),
            },
            error: null,
        }
    }

    const players: PuttingGameState['players'] = ordered.map((p) => ({
        finalGameId: p.id,
        order: p.final_game_order,
        name: p.player.name,
        status: (p.last_result === 'out' ? 'out' : 'active') as 'active' | 'out',
        lastLevel: p.last_level,
        lastResult: p.last_result,
    }))

    const currentTurnName = gameState.current_turn_final_game_participant_id
        ? nameById.get(gameState.current_turn_final_game_participant_id) ?? null
        : null
    const winnerName = gameState.winner_final_game_participant_id
        ? nameById.get(gameState.winner_final_game_participant_id) ?? null
        : null

    return {
        state: {
            status: gameState.status as PuttingGameState['status'],
            currentLevel: gameState.current_level,
            currentTurnFinalGameId: gameState.current_turn_final_game_participant_id,
            currentTurnName,
            winnerFinalGameId: gameState.winner_final_game_participant_id,
            winnerName,
            players,
        },
        error: null,
    }
}

/** Converts PuttingGameState to the broadcast payload shape (FinalGamePuttingResponse). */
export function puttingStateToResponse(state: PuttingGameState): { puttingGame: {
    gameStatus: PuttingGameState['status']
    currentLevel: number
    currentTurnParticipantId: number | null
    currentTurnName: string | null
    winnerName: string | null
    players: { id: number; order: number; name: string; status: 'active' | 'out'; lastLevel: number; lastResult: 'in' | 'out' | null }[]
} } {
    return {
        puttingGame: {
            gameStatus: state.status,
            currentLevel: state.currentLevel,
            currentTurnParticipantId: state.currentTurnFinalGameId,
            currentTurnName: state.currentTurnName,
            winnerName: state.winnerName,
            players: state.players.map((p) => ({
                id: p.finalGameId,
                order: p.order,
                name: p.name,
                status: p.status,
                lastLevel: p.lastLevel,
                lastResult: p.lastResult,
            })),
        },
    }
}

export async function startPuttingGame(env: Env, competitionId: number): Promise<{ error: string | null }> {
    const supabase = getSupabaseClient(env)
    const { data: participants } = await getFinalGameParticipants(env, competitionId)
    if (!participants || participants.length !== 10) {
        return { error: 'Exactly 10 participants required' }
    }

    const ordered = [...participants].sort((a, b) => a.final_game_order - b.final_game_order)
    const firstId = ordered[0]!.id

    const { state: gameState } = await getGameState(env, competitionId)
    const now = new Date().toISOString()

    if (gameState) {
        const { error } = await supabase
            .from('final_game_state')
            .update({
                status: 'running',
                current_level: 1,
                current_turn_final_game_participant_id: firstId,
                winner_final_game_participant_id: null,
                started_at: now,
                finished_at: null,
                updated_at: now,
            })
            .eq('id', gameState.id)
        if (error) return { error: error.message }
    } else {
        const { error } = await supabase.from('final_game_state').insert({
            metrix_competition_id: competitionId,
            status: 'running',
            current_level: 1,
            current_turn_final_game_participant_id: firstId,
            started_at: now,
            updated_at: now,
        })
        if (error) return { error: error.message }
    }

    const { error: resetErr } = await supabase
        .from('final_game_participant')
        .update({ last_level: 0, last_result: null })
        .eq('metrix_competition_id', competitionId)
    if (resetErr) return { error: resetErr.message }

    return { error: null }
}

export async function resetPuttingGame(env: Env, competitionId: number): Promise<{ error: string | null }> {
    const supabase = getSupabaseClient(env)
    const { state: gameState } = await getGameState(env, competitionId)
    if (gameState) {
        const { error: deleteErr } = await supabase.from('final_game_state').delete().eq('id', gameState.id)
        if (deleteErr) return { error: deleteErr.message }
    }
    return startPuttingGame(env, competitionId)
}

export async function recordPuttingResult(
    env: Env,
    competitionId: number,
    participantId: number,
    result: 'in' | 'out'
): Promise<{ error: string | null; payload?: ReturnType<typeof puttingStateToResponse> }> {
    const supabase = getSupabaseClient(env)
    const { state: gameState, error: stateErr } = await getGameState(env, competitionId)
    if (stateErr || !gameState || gameState.status !== 'running') {
        return { error: stateErr ?? 'Game not running' }
    }
    if (gameState.current_turn_final_game_participant_id !== participantId) {
        return { error: 'Not current turn' }
    }

    const currentLevel = gameState.current_level
    const now = new Date().toISOString()

    const { error: updateErr } = await supabase
        .from('final_game_participant')
        .update({ last_level: currentLevel, last_result: result })
        .eq('id', participantId)
        .eq('metrix_competition_id', competitionId)
    if (updateErr) return { error: updateErr.message }

    const { data: participants } = await getFinalGameParticipants(env, competitionId)
    if (!participants || participants.length === 0) return { error: 'No participants' }

    const ordered = [...participants].sort((a, b) => a.final_game_order - b.final_game_order)

    const isActive = (p: FinalGameParticipant) => {
        const lr = p.id === participantId ? result : p.last_result
        return lr !== 'out'
    }

    const nextParticipant = getNextActiveInOrder(ordered, participantId, isActive)
    const activeCount = ordered.filter(isActive).length

    if (!nextParticipant) {
        if (activeCount === 1) {
            const winner = ordered.find(isActive)!
            const { error: finishErr } = await supabase
                .from('final_game_state')
                .update({
                    status: 'finished',
                    current_turn_final_game_participant_id: null,
                    winner_final_game_participant_id: winner.id,
                    finished_at: now,
                    updated_at: now,
                })
                .eq('id', gameState.id)
            if (finishErr) return { error: finishErr.message }
            const { state: next } = await getPuttingGameState(env, competitionId)
            return { error: null, payload: next ? puttingStateToResponse(next) : undefined }
        }
        if (activeCount === 0) {
            const attemptedThisRoundIds = [
                participantId,
                ...ordered.filter((p) => p.id !== participantId && p.last_level === currentLevel).map((p) => p.id),
            ]
            const prevLevel = Math.max(0, currentLevel - 1)
            const { error: revertErr } = await supabase
                .from('final_game_participant')
                .update({ last_level: prevLevel, last_result: prevLevel > 0 ? 'in' : null })
                .in('id', attemptedThisRoundIds)
                .eq('metrix_competition_id', competitionId)
            if (revertErr) return { error: revertErr.message }
            const { error: turnErr } = await supabase
                .from('final_game_state')
                .update({
                    current_turn_final_game_participant_id: ordered[0]!.id,
                    updated_at: now,
                })
                .eq('id', gameState.id)
            if (turnErr) return { error: turnErr.message }
            const { state: next } = await getPuttingGameState(env, competitionId)
            return { error: null, payload: next ? puttingStateToResponse(next) : undefined }
        }
        return { error: 'Unexpected state' }
    }

    const roundComplete = ordered.filter(isActive).every(
        (p) => (p.id === participantId ? currentLevel : p.last_level) === currentLevel
    )

    if (!roundComplete) {
        const { error: turnErr } = await supabase
            .from('final_game_state')
            .update({
                current_turn_final_game_participant_id: nextParticipant.id,
                updated_at: now,
            })
            .eq('id', gameState.id)
        if (turnErr) return { error: turnErr.message }
        const { state: next } = await getPuttingGameState(env, competitionId)
        return { error: null, payload: next ? puttingStateToResponse(next) : undefined }
    }

    const firstActive = ordered.find(isActive)!
    const attemptedThisRoundIds = [
        participantId,
        ...ordered.filter((p) => p.id !== participantId && p.last_level === currentLevel).map((p) => p.id),
    ]
    const madeCount = attemptedThisRoundIds.filter(
        (id) => (id === participantId ? result === 'in' : participants.find((p) => p.id === id)?.last_result === 'in')
    ).length

    if (madeCount >= 1) {
        if (madeCount === 1) {
            const winner = attemptedThisRoundIds.find(
                (id) => id === participantId ? result === 'in' : participants.find((p) => p.id === id)?.last_result === 'in'
            )!
            const { error: finishErr } = await supabase
                .from('final_game_state')
                .update({
                    status: 'finished',
                    current_turn_final_game_participant_id: null,
                    winner_final_game_participant_id: winner,
                    finished_at: now,
                    updated_at: now,
                })
                .eq('id', gameState.id)
            if (finishErr) return { error: finishErr.message }
            const { state: next } = await getPuttingGameState(env, competitionId)
            return { error: null, payload: next ? puttingStateToResponse(next) : undefined }
        }
        const newLevel = currentLevel + 1
        const { error: advanceErr } = await supabase
            .from('final_game_state')
            .update({
                current_level: newLevel,
                current_turn_final_game_participant_id: firstActive.id,
                updated_at: now,
            })
            .eq('id', gameState.id)
        if (advanceErr) return { error: advanceErr.message }
        const { state: next } = await getPuttingGameState(env, competitionId)
        return { error: null, payload: next ? puttingStateToResponse(next) : undefined }
    }

    const prevLevel = Math.max(0, currentLevel - 1)
    const { error: revertErr } = await supabase
        .from('final_game_participant')
        .update({ last_level: prevLevel, last_result: prevLevel > 0 ? 'in' : null })
        .in('id', attemptedThisRoundIds)
        .eq('metrix_competition_id', competitionId)
    if (revertErr) return { error: revertErr.message }

    const { error: turnErr } = await supabase
        .from('final_game_state')
        .update({
            current_turn_final_game_participant_id: ordered[0]!.id,
            updated_at: now,
        })
        .eq('id', gameState.id)
    if (turnErr) return { error: turnErr.message }
    const { state: next } = await getPuttingGameState(env, competitionId)
    return { error: null, payload: next ? puttingStateToResponse(next) : undefined }
}
