import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState } from '@cloudflare/workers-types'
import type { Env } from '../shared/types'
import { getFinalGamePuttingPayload } from './finalGameState'
import type { FinalGamePuttingResponse } from './finalGameState'
import { base64DecodeUtf8 } from './base64'

const INITIAL_STATE_HEADER = 'X-Initial-Final-Game-Putting-State'
const COMPETITION_ID_HEADER = 'X-Competition-Id'

const HEARTBEAT_INTERVAL_MS = 90_000

type StreamEntry = {
    write: (data: string) => Promise<void>
    close: () => void
}

function parseCompetitionId(id: DurableObjectState['id']): number | null {
    // Try to get the name from the ID
    let name: string | undefined
    if ('name' in id && typeof id.name === 'string') {
        name = id.name
    } else {
        // Fallback to toString, but check if it looks like a name
        const str = id.toString()
        if (str.includes('final-game-putting-')) {
            name = str
        } else {
            // If toString doesn't contain the prefix, it's likely a numeric ID, which we can't parse
            console.error('[FinalGamePuttingDO] Unable to parse competition ID from:', { id, name: id.name, toString: str })
            return null
        }
    }
    
    const prefix = 'final-game-putting-'
    if (!name.startsWith(prefix)) {
        console.error('[FinalGamePuttingDO] ID name does not start with expected prefix:', { name, prefix })
        return null
    }
    
    const num = name.slice(prefix.length)
    const parsed = parseInt(num, 10)
    if (isNaN(parsed)) {
        console.error('[FinalGamePuttingDO] Failed to parse competition ID number:', { name, num })
        return null
    }
    
    return parsed
}

function sseMessage(data: FinalGamePuttingResponse): string {
    return `data: ${JSON.stringify(data)}\n\n`
}

export class FinalGamePuttingDO extends DurableObject<Env> {
    private streams: StreamEntry[] = []
    private heartbeatTimer: ReturnType<typeof setTimeout> | null = null

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        if (request.method === 'POST' && url.pathname.endsWith('/broadcast')) {
            return this.handleBroadcast(request)
        }
        if (request.method === 'GET') {
            return this.handleGet(request)
        }
        return new Response('Not Found', { status: 404 })
    }

    private async handleGet(request: Request): Promise<Response> {
        // Try to get competition ID from header first (more reliable)
        let competitionId: number | null = null
        const competitionIdHeader = request.headers.get(COMPETITION_ID_HEADER)
        if (competitionIdHeader) {
            const parsed = parseInt(competitionIdHeader, 10)
            if (!isNaN(parsed)) {
                competitionId = parsed
            }
        }
        
        // Fallback to parsing from DO ID if header not available
        if (competitionId === null) {
            competitionId = parseCompetitionId(this.ctx.id)
        }
        
        if (competitionId === null) {
            return new Response(JSON.stringify({ error: 'Invalid competition' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            })
        }

        const encoder = new TextEncoder()
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
        const writer = writable.getWriter()

        const write = async (data: string) => {
            await writer.write(encoder.encode(data))
        }

        const close = () => {
            this.removeStream(entry)
            writer.close().catch(() => {})
        }

        const entry: StreamEntry = { write, close }
        this.streams.push(entry)
        console.log('[FinalGamePuttingDO] handleGet: new stream added competitionId=', competitionId, 'total streams=', this.streams.length)

        const initialStateHeader = request.headers.get(INITIAL_STATE_HEADER)
        let state: FinalGamePuttingResponse | null = null
        if (initialStateHeader) {
            try {
                state = JSON.parse(base64DecodeUtf8(initialStateHeader)) as FinalGamePuttingResponse
            } catch {
                // ignore
            }
        }

        this.ctx.waitUntil(
            (async () => {
                try {
                    const resolvedState = state ?? (await getFinalGamePuttingPayload(this.env, competitionId))
                    if (resolvedState) {
                        await write(sseMessage(resolvedState))
                    } else {
                        await write(sseMessage({ puttingGame: { gameStatus: 'not_started', currentLevel: 1, currentTurnParticipantId: null, currentTurnName: null, winnerName: null, players: [] } })).catch(() => {})
                    }
                } catch (e) {
                    await write(sseMessage({ puttingGame: { gameStatus: 'not_started', currentLevel: 1, currentTurnParticipantId: null, currentTurnName: null, winnerName: null, players: [] } })).catch(() => {})
                }
                if (!this.heartbeatTimer) {
                    const scheduleNext = (): void => {
                        this.heartbeatTimer = setTimeout(async () => {
                            try {
                                await this.broadcastToAll(': heartbeat\n\n')
                            } catch (err) {
                                console.error('[FinalGamePuttingDO] heartbeat broadcast error:', err)
                            }
                            scheduleNext()
                        }, HEARTBEAT_INTERVAL_MS)
                    }
                    scheduleNext()
                }
            })()
        )

        this.ctx.waitUntil(
            (async () => {
                try {
                    await writer.closed
                } finally {
                    close()
                    if (this.streams.length === 0 && this.heartbeatTimer) {
                        clearTimeout(this.heartbeatTimer)
                        this.heartbeatTimer = null
                    }
                }
            })()
        )

        return new Response(readable, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store',
                Connection: 'keep-alive',
            },
        })
    }

    private async handleBroadcast(request: Request): Promise<Response> {
        let body: FinalGamePuttingResponse
        try {
            body = (await request.json()) as FinalGamePuttingResponse
        } catch {
            console.warn('[FinalGamePuttingDO] handleBroadcast: Invalid JSON')
            return new Response('Invalid JSON', { status: 400 })
        }
        const competitionId = parseCompetitionId(this.ctx.id)
        console.log('[FinalGamePuttingDO] handleBroadcast: competitionId=', competitionId, 'streams=', this.streams.length, 'gameStatus=', body.puttingGame?.gameStatus)
        const msg = sseMessage(body)
        await this.broadcastToAll(msg)
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
        })
    }

    private removeStream(entry: StreamEntry): void {
        const before = this.streams.length
        this.streams = this.streams.filter((s) => s !== entry)
        if (this.streams.length < before) {
            console.log('[FinalGamePuttingDO] removeStream: stream removed, remaining=', this.streams.length)
        }
    }

    private async broadcastToAll(data: string): Promise<void> {
        const dead: StreamEntry[] = []
        const n = this.streams.length
        console.log('[FinalGamePuttingDO] broadcastToAll: writing to', n, 'stream(s)')
        await Promise.all(
            this.streams.map(async (entry, i) => {
                try {
                    await entry.write(data)
                } catch (err) {
                    console.warn('[FinalGamePuttingDO] broadcastToAll: stream', i, 'write failed', err)
                    dead.push(entry)
                }
            })
        )
        if (dead.length > 0) {
            console.log('[FinalGamePuttingDO] broadcastToAll: removing', dead.length, 'dead stream(s), remaining=', this.streams.length - dead.length)
        }
        dead.forEach((entry) => this.removeStream(entry))
    }
}
