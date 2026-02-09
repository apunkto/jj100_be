import type {Env} from '../shared/types'
import {getCheckedInPlayers} from './service'

const KV_KEY_PREFIX = 'draw:'

export type DrawStateValue = {
    participantCount: number
    countdownStartedAt?: number
    winnerName?: string
    participantNames?: string[]
}

export type DrawStateResponse = {
    participantCount: number
    countdown?: number
    winnerName?: string
    participantNames?: string[]
}

function kvKey(competitionId: number): string {
    return `${KV_KEY_PREFIX}${competitionId}`
}

export async function getDrawState(env: Env, competitionId: number): Promise<DrawStateResponse> {
    const raw = await env.DRAW_STATE.get(kvKey(competitionId))
    const { data: checkins } = await getCheckedInPlayers(env, competitionId)
    const participantCount = (checkins ?? []).filter((p) => !p.prize_won).length

    if (!raw) {
        return { participantCount }
    }

    let value: DrawStateValue
    try {
        value = JSON.parse(raw) as DrawStateValue
    } catch {
        return { participantCount }
    }

    const hasActiveDraw = value.countdownStartedAt != null && value.winnerName != null
    const storedCount = value.participantCount ?? 0
    const response: DrawStateResponse = {
        // When idle: use live count, but never show 0 if we have a stored count (e.g. after reset, DO fetch can lag or differ).
        // When draw in progress: use stored count with live fallback.
        participantCount: hasActiveDraw
            ? (value.participantCount ?? participantCount)
            : Math.max(participantCount, storedCount),
    }

    if (hasActiveDraw && value.countdownStartedAt != null) {
        const countdown = Math.max(0, 3 - Math.floor((Date.now() - value.countdownStartedAt) / 1000))
        response.countdown = countdown
        response.winnerName = value.winnerName
        if (value.participantNames != null) response.participantNames = value.participantNames
    }

    return response
}

export async function setDrawState(
    env: Env,
    competitionId: number,
    value: DrawStateValue
): Promise<void> {
    await env.DRAW_STATE.put(kvKey(competitionId), JSON.stringify(value))
}

export async function deleteDrawState(env: Env, competitionId: number): Promise<void> {
    await env.DRAW_STATE.delete(kvKey(competitionId))
}

export async function getEligibleDrawCount(env: Env, competitionId: number): Promise<number> {
    const { data } = await getCheckedInPlayers(env, competitionId)
    return (data ?? []).filter((p) => !p.prize_won).length
}
