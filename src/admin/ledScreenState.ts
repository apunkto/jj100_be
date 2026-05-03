import type {Env} from '../shared/types'

const KV_KEY_PREFIX = 'led-screen:'

export const LED_SCREEN_BOARDS = [
    'main',
    'leaderboard',
    'draw',
    'finalDraw',
    'finalPutting',
] as const

export type LedScreenBoard = (typeof LED_SCREEN_BOARDS)[number]

export type LeaderboardPanel = 'division' | 'prediction'

export type LedScreenStateValue = {
    board: LedScreenBoard
    /** Division name as shown in Metrix (must match `topPlayersByDivision` keys). */
    leaderboardDivision?: string | null
    /** When `board` is `leaderboard`, which single view to show. */
    leaderboardPanel?: LeaderboardPanel | null
}

const DEFAULT_STATE: LedScreenStateValue = {
    board: 'main',
    leaderboardDivision: null,
    leaderboardPanel: 'division',
}

function kvKey(competitionId: number): string {
    return `${KV_KEY_PREFIX}${competitionId}`
}

function isBoard(s: string): s is LedScreenBoard {
    return (LED_SCREEN_BOARDS as readonly string[]).includes(s)
}

export async function getLedScreenState(env: Env, competitionId: number): Promise<LedScreenStateValue> {
    const raw = await env.DRAW_STATE.get(kvKey(competitionId))
    if (!raw) return { ...DEFAULT_STATE }

    try {
        const value = JSON.parse(raw) as Partial<LedScreenStateValue>
        if (typeof value.board === 'string' && isBoard(value.board)) {
            const panel: LeaderboardPanel =
                value.leaderboardPanel === 'prediction' ? 'prediction' : 'division'
            return {
                board: value.board,
                leaderboardDivision:
                    value.leaderboardDivision === undefined || value.leaderboardDivision === null
                        ? null
                        : String(value.leaderboardDivision),
                leaderboardPanel: panel,
            }
        }
    } catch {
        // ignore
    }
    return { ...DEFAULT_STATE }
}

export async function setLedScreenState(env: Env, competitionId: number, value: LedScreenStateValue): Promise<void> {
    await env.DRAW_STATE.put(kvKey(competitionId), JSON.stringify(value))
}
