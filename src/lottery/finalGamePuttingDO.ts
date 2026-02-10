import {DurableObject} from 'cloudflare:workers'
import type {Env} from '../shared/types'
import {base64DecodeUtf8} from './base64'
import {PuttingGameState} from "./puttingGame";

const INITIAL_STATE_HEADER = 'X-Initial-Final-Game-Putting-State'
const COMPETITION_ID_HEADER = 'X-Competition-Id'

/** Minimal type for DO id (name/toString) to avoid mixing workers-types with cloudflare:workers runtime types. */
type DurableObjectIdLike = { name?: string; toString(): string }

/** Keep well under Cloudflare’s ~100s stream idle timeout and worker–DO RPC ~90s limit so the worker stays connected and can receive broadcasts. */
const HEARTBEAT_INTERVAL_MS = 25_000

type StreamEntry = {
    write: (data: string) => Promise<void>
    close: () => void
}

function sseMessage(data: PuttingGameState): string {
    return `data: ${JSON.stringify(data)}\n\n`
}

export class FinalGamePuttingDO extends DurableObject<Env> {
    private streams: StreamEntry[] = []
    private heartbeatTimer: ReturnType<typeof setTimeout> | null = null

    constructor(ctx: ConstructorParameters<typeof DurableObject<Env>>[0], env: Env) {
        super(ctx, env)
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        try {
            if (request.method === 'POST' && url.pathname.endsWith('/broadcast')) {
                return await this.handleBroadcast(request)
            }
            if (request.method === 'GET') {
                return await this.handleGet(request)
            }
            return new Response('Not Found', {status: 404})
        } catch (err) {
            console.error('[FinalGamePuttingDO] fetch error', err)
            return new Response(JSON.stringify({error: String(err)}), {
                status: 500,
                headers: {'Content-Type': 'application/json'},
            })
        }
    }

    private async handleGet(request: Request): Promise<Response> {
        const encoder = new TextEncoder()
        const {readable, writable} = new TransformStream<Uint8Array, Uint8Array>()
        const writer = writable.getWriter()

        const write = async (data: string) => {
            await writer.write(encoder.encode(data))
        }

        const close = () => {
            this.removeStream(entry)
            writer.close().catch(() => {
            })
        }

        const entry: StreamEntry = {write, close}
        this.streams.push(entry)

        const initialStateHeader = request.headers.get(INITIAL_STATE_HEADER)
        let state: PuttingGameState | null = null
        if (initialStateHeader) {
            try {
                state = JSON.parse(base64DecodeUtf8(initialStateHeader)) as PuttingGameState
            } catch {
                // ignore
            }
        }

        this.ctx.waitUntil(
            (async () => {
                try {
                    const resolvedState = state;
                    if (resolvedState) {
                        await write(sseMessage(resolvedState))
                    } else {
                        await write(sseMessage({
                            status: 'not_started',
                            currentLevel: 1,
                            currentTurnParticipantId: null,
                            currentTurnName: null,
                            winnerName: null,
                            winnerId: null,
                            players: []
                        })).catch(() => {
                        })
                    }
                } catch (e) {
                    console.error('[FinalGamePuttingDO] initial state send error', e)
                    try {
                        await write(sseMessage({
                            status: 'not_started',
                            currentLevel: 1,
                            currentTurnParticipantId: null,
                            currentTurnName: null,
                            winnerName: null,
                            winnerId: null,
                            players: []
                        })).catch(() => {
                        })
                    } catch (_) {
                        // ignore
                    }
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
            })().catch((err) => console.error('[FinalGamePuttingDO] waitUntil initial state rejected', err))
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
            })().catch((err) => console.error('[FinalGamePuttingDO] waitUntil writer.closed rejected', err))
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
        let body: PuttingGameState
        try {
            body = (await request.json()) as PuttingGameState
        } catch (e) {
            console.error('[FinalGamePuttingDO] handleBroadcast: Invalid JSON', e)
            return new Response('Invalid JSON', {status: 400})
        }
        const streamCount = this.streams.length
        try {
            const msg = sseMessage(body)
            await this.broadcastToAll(msg)
        } catch (e) {
            console.error('[FinalGamePuttingDO] handleBroadcast broadcastToAll failed', e)
            return new Response(JSON.stringify({success: false, error: String(e)}), {
                status: 500,
                headers: {'Content-Type': 'application/json'},
            })
        }
        return new Response(
            JSON.stringify({success: true, streamsWritten: streamCount}),
            {headers: {'Content-Type': 'application/json'}}
        )
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
        console.debug('[FinalGamePuttingDO] broadcastToAll: writing to ' + n + ' stream(s)')
        await Promise.all(
            this.streams.map(async (entry, i) => {
                try {
                    await entry.write(data)
                } catch (err) {
                    console.error('[FinalGamePuttingDO] broadcastToAll: stream ' + i + ' write failed', err)
                    dead.push(entry)
                }
            })
        )
        if (dead.length > 0) {
            console.warn('[FinalGamePuttingDO] broadcastToAll: removing ' + dead.length + ' dead stream(s)')
        }
        dead.forEach((entry) => this.removeStream(entry))
    }
}
