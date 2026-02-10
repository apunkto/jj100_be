import type {Env} from '../shared/types'
import {getSupabaseClient} from '../shared/supabase'
import type {FinalGameParticipant, FinalGameParticipantDto} from './service'

export type PuttingGameState = {
    status: 'not_started' | 'running' | 'finished'
    currentLevel: number
    currentTurnParticipantId: number | null
    currentTurnName: string | null
    winnerId: number | null
    winnerName: string | null
    players: FinalGameParticipantDto[]
}

type StateRow = {
    id: number
    metrix_competition_id: number
    status: string
    current_level: number
    current_turn_final_game_participant_id: number | null
    winner_final_game_participant_id: number | null
}

async function getGameState(env: Env, competitionId: number): Promise<{
    state: StateRow | null;
    error: string | null
}> {
    const supabase = getSupabaseClient(env)
    const {data, error} = await supabase
        .from('final_game_state')
        .select('id, metrix_competition_id, status, current_level, current_turn_final_game_participant_id, winner_final_game_participant_id')
        .eq('metrix_competition_id', competitionId)
        .maybeSingle()
    if (error) return {state: null, error: error.message}
    return {state: data as StateRow | null, error: null}
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

export async function getPuttingGameState(
    env: Env,
    competitionId: number,
    options: { participants: FinalGameParticipant[] }
): Promise<{
    state: PuttingGameState | null
    error: string | null
}> {
    const {state: gameState, error: stateErr} = await getGameState(env, competitionId)
    if (stateErr) return {state: null, error: stateErr}

    let participants = options?.participants

    const nameById = new Map(participants.map((p) => [p.id, p.player.name]))

    if (!gameState) {
        return {
            state: {
                status: 'not_started',
                currentLevel: 1,
                currentTurnParticipantId: null,
                currentTurnName: null,
                winnerId: null,
                winnerName: null,
                players: participants.map(  p => ({
                    finalParticipantId: p.id,
                    name: p.player.name,
                    order: p.final_game_order,
                    playerId: p.player.id,
                    lastLevel: p.last_level,
                    lastResult: p.last_result,
                } as FinalGameParticipantDto) ),
            },
            error: null,
        }
    }

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
            currentTurnParticipantId: gameState.current_turn_final_game_participant_id,
            currentTurnName,
            winnerId: gameState.winner_final_game_participant_id,
            winnerName,
            players: participants.map(  p => ({
                finalParticipantId: p.id,
                name: p.player.name,
                order: p.final_game_order,
                playerId: p.player.id,
                lastLevel: p.last_level,
                lastResult: p.last_result,
                status: p.last_result === 'out' ? 'out' : gameState.status === 'finished' && p.id === gameState.winner_final_game_participant_id ? 'winner' : 'active',
            } as FinalGameParticipantDto) ),
        },
        error: null,
    }
}


export async function startPuttingGame(env: Env, competitionId: number,
                                       participants: FinalGameParticipant[]): Promise<{ error: string | null }> {
    const supabase = getSupabaseClient(env)

    const ordered = [...participants].sort((a, b) => a.final_game_order - b.final_game_order)
    const firstId = ordered[0]!.id

    const {state: gameState} = await getGameState(env, competitionId)
    const now = new Date().toISOString()

    if (gameState) {
        const {error} = await supabase
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
        if (error) return {error: error.message}
    } else {
        const {error} = await supabase.from('final_game_state').insert({
            metrix_competition_id: competitionId,
            status: 'running',
            current_level: 1,
            current_turn_final_game_participant_id: firstId,
            started_at: now,
            updated_at: now,
        })
        if (error) return {error: error.message}
    }

    const {error: resetErr} = await supabase
        .from('final_game_participant')
        .update({last_level: 0, last_result: null})
        .eq('metrix_competition_id', competitionId)
    if (resetErr) return {error: resetErr.message}

    return {error: null}
}

export async function resetPuttingGame(env: Env, competitionId: number, participants: FinalGameParticipant[]): Promise<{
    error: string | null
}> {
    const supabase = getSupabaseClient(env)
    const {state: gameState} = await getGameState(env, competitionId)
    if (gameState) {
        const {error: deleteErr} = await supabase.from('final_game_state').delete().eq('id', gameState.id)
        if (deleteErr) return {error: deleteErr.message}
    }
    return startPuttingGame(env, competitionId, participants)
}

export async function recordPuttingResult(
    env: Env,
    competitionId: number,
    participantId: number,
    result: 'in' | 'out',
    participants: FinalGameParticipant[]
): Promise<{ error: string | null; payload?: PuttingGameState | null }> {
    const supabase = getSupabaseClient(env)

    const { state: gameState, error: stateErr } = await getGameState(env, competitionId)
    if (stateErr || !gameState || gameState.status !== 'running') {
        return { error: stateErr ?? 'Game not running' }
    }
    if (gameState.current_turn_final_game_participant_id !== participantId) {
        return {
            error:
                'Not current turn. If you use the page on Cloudflare but send attempts from local (or vice versa), use the same API for both.',
        }
    }

    const now = new Date().toISOString()
    const currentLevel = gameState.current_level

    // O(1) access helpers (index map is stable; we patch by index)
    const idxById = new Map<number, number>()
    for (let i = 0; i < participants.length; i++) idxById.set(participants[i]!.id, i)

    const getP = (id: number): FinalGameParticipant | null => {
        const idx = idxById.get(id)
        return idx == null ? null : participants[idx] ?? null
    }

    // 2) Update single participant AND patch in-memory from returned row
    const { data: updatedP, error: updateErr } = await supabase
        .from('final_game_participant')
        .update({ last_level: currentLevel, last_result: result })
        .eq('id', participantId)
        .eq('metrix_competition_id', competitionId)
        .select('id,last_level,last_result')
        .single()

    if (updateErr) return { error: updateErr.message }
    if (!updatedP) return { error: 'Failed to update participant' }

    {
        const idx = idxById.get(updatedP.id)
        if (idx == null) return { error: 'Participant not found in list' }
        // patch only the changed fields (keep player/order fields intact)
        participants[idx] = {
            ...participants[idx]!,
            last_level: updatedP.last_level,
            last_result: updatedP.last_result,
        }
    }

    const isActive = (p: FinalGameParticipant) => p.last_result !== 'out'

    const nextParticipant = getNextActiveInOrder(participants, participantId, isActive)
    const activeCount = participants.reduce((acc, p) => acc + (p.last_result !== 'out' ? 1 : 0), 0)

    if (!nextParticipant) {
        if (activeCount === 1) {
            const winner = participants.find((p) => p.last_result !== 'out')
            if (!winner) return { error: 'Unexpected state' }

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

            const { state: next } = await getPuttingGameState(env, competitionId, { participants })
            return { error: null, payload: next }
        }

        if (activeCount === 0) {
            const attemptedThisRoundIds = [
                participantId,
                ...participants
                    .filter((p) => p.id !== participantId && p.last_level === currentLevel)
                    .map((p) => p.id),
            ]
            const prevLevel = Math.max(0, currentLevel - 1)

            // 3) Bulk update revert AND patch in-memory from returned rows
            const { data: reverted, error: revertErr } = await supabase
                .from('final_game_participant')
                .update({ last_level: prevLevel, last_result: prevLevel > 0 ? 'in' : null })
                .in('id', attemptedThisRoundIds)
                .eq('metrix_competition_id', competitionId)
                .select('id,last_level,last_result')
            if (revertErr) return { error: revertErr.message }

            if (reverted) {
                for (const r of reverted) {
                    const idx = idxById.get(r.id)
                    if (idx != null) {
                        participants[idx] = {
                            ...participants[idx]!,
                            last_level: r.last_level,
                            last_result: r.last_result,
                        }
                    }
                }
            }

            const { error: turnErr } = await supabase
                .from('final_game_state')
                .update({
                    current_turn_final_game_participant_id: participants[0]!.id,
                    updated_at: now,
                })
                .eq('id', gameState.id)
            if (turnErr) return { error: turnErr.message }

            const { state: next } = await getPuttingGameState(env, competitionId, { participants })
            return { error: null, payload: next }
        }

        return { error: 'Unexpected state' }
    }

    const roundComplete = participants
        .filter((p) => p.last_result !== 'out')
        .every((p) => p.last_level === currentLevel)

    if (!roundComplete) {
        const { error: turnErr } = await supabase
            .from('final_game_state')
            .update({
                current_turn_final_game_participant_id: nextParticipant.id,
                updated_at: now,
            })
            .eq('id', gameState.id)
        if (turnErr) return { error: turnErr.message }
        const { state: next } = await getPuttingGameState(env, competitionId, { participants })
        return { error: null, payload: next }
    }

    const firstActive = participants.find((p) => p.last_result !== 'out')
    if (!firstActive) return { error: 'Unexpected state' }

    const attemptedThisRoundIds = [
        participantId,
        ...participants
            .filter((p) => p.id !== participantId && p.last_level === currentLevel)
            .map((p) => p.id),
    ]

    const madeCount = attemptedThisRoundIds.reduce((acc, id) => acc + ((getP(id)?.last_result ?? null) === 'in' ? 1 : 0), 0)

    if (madeCount >= 1) {
        if (madeCount === 1) {
            const winner = attemptedThisRoundIds.find((id) => (getP(id)?.last_result ?? null) === 'in')
            if (winner == null) return { error: 'Unexpected state' }

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

            const { state: next } = await getPuttingGameState(env, competitionId, { participants })
            return { error: null, payload: next }
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

        const { state: next } = await getPuttingGameState(env, competitionId, { participants })
        return { error: null, payload: next }
    }

    // Nobody made it: revert this round
    const prevLevel = Math.max(0, currentLevel - 1)

    // 3) Bulk update revert AND patch in-memory from returned rows
    const { data: reverted, error: revertErr } = await supabase
        .from('final_game_participant')
        .update({ last_level: prevLevel, last_result: prevLevel > 0 ? 'in' : null })
        .in('id', attemptedThisRoundIds)
        .eq('metrix_competition_id', competitionId)
        .select('id,last_level,last_result')
    if (revertErr) return { error: revertErr.message }

    if (reverted) {
        for (const r of reverted) {
            const idx = idxById.get(r.id)
            if (idx != null) {
                participants[idx] = {
                    ...participants[idx]!,
                    last_level: r.last_level,
                    last_result: r.last_result,
                }
            }
        }
    }

    const { error: turnErr } = await supabase
        .from('final_game_state')
        .update({
            current_turn_final_game_participant_id: participants[0]!.id,
            updated_at: now,
        })
        .eq('id', gameState.id)
    if (turnErr) return { error: turnErr.message }

    const { state: next } = await getPuttingGameState(env, competitionId, { participants })
    return { error: null, payload: next }
}
