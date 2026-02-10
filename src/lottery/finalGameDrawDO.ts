import {DurableObject} from 'cloudflare:workers'
import type {Env} from '../shared/types'
import type {FinalGameDrawResponse} from './finalGameDrawState'
import {getFinalGameDrawState} from './finalGameDrawState'
import {base64DecodeUtf8} from './base64'

const INITIAL_STATE_HEADER = 'X-Initial-Final-Game-Draw-State'
const COMPETITION_ID_HEADER = 'X-Competition-Id'

/** Minimal type for DO id to avoid mixing workers-types with cloudflare:workers runtime types. */
type DurableObjectIdLike = { name?: string; toString(): string }

/** Keep under Cloudflare stream idle timeout (~100s) and worker–DO RPC limit (~90s). */
const HEARTBEAT_INTERVAL_MS = 29_000

type StreamEntry = {
    write: (data: string) => Promise<void>
    close: () => void
}

function parseCompetitionId(id: DurableObjectIdLike): number | null {
    // Try to get the name from the ID
    let name: string | undefined
    if ('name' in id && typeof id.name === 'string') {
        name = id.name
    } else {
        // Fallback to toString, but check if it looks like a name
        const str = id.toString()
        if (str.includes('final-game-draw-')) {
            name = str
        } else {
            // If toString doesn't contain the prefix, it's likely a numeric ID, which we can't parse
            console.error('[FinalGameDrawDO] Unable to parse competition ID from:', { id, name: id.name, toString: str })
            return null
        }
    }
    
    const prefix = 'final-game-draw-'
    if (!name.startsWith(prefix)) {
        console.error('[FinalGameDrawDO] ID name does not start with expected prefix:', { name, prefix })
        return null
    }
    
    const num = name.slice(prefix.length)
    const parsed = parseInt(num, 10)
    if (isNaN(parsed)) {
        console.error('[FinalGameDrawDO] Failed to parse competition ID number:', { name, num })
        return null
    }
    
    return parsed
}

function sseMessage(data: FinalGameDrawResponse): string {
    return `data: ${JSON.stringify(data)}\n\n`
}

export class FinalGameDrawDO extends DurableObject<Env> {
    private streams: StreamEntry[] = []
    private heartbeatTimer: ReturnType<typeof setTimeout> | null = null

    constructor(ctx: ConstructorParameters<typeof DurableObject<Env>>[0], env: Env) {
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

        const initialStateHeader = request.headers.get(INITIAL_STATE_HEADER)
        let state: FinalGameDrawResponse | null = null
        if (initialStateHeader) {
            try {
                state = JSON.parse(base64DecodeUtf8(initialStateHeader)) as FinalGameDrawResponse
            } catch {
                // ignore
            }
        }

        this.ctx.waitUntil(
            (async () => {
                try {
                    const resolvedState = state ?? (await getFinalGameDrawState(this.env, competitionId))
                    await write(sseMessage(resolvedState))
                } catch (e) {
                    await write(sseMessage({ finalGameParticipants: [], participantCount: 0 })).catch(() => {})
                }
                if (!this.heartbeatTimer) {
                    const scheduleNext = (): void => {
                        this.heartbeatTimer = setTimeout(async () => {
                            try {
                                await this.broadcastToAll(': heartbeat\n\n')
                            } catch (err) {
                                console.error('[FinalGameDrawDO] heartbeat broadcast error:', err)
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
        let body: FinalGameDrawResponse
        try {
            body = (await request.json()) as FinalGameDrawResponse
        } catch {
            return new Response('Invalid JSON', { status: 400 })
        }
        const msg = sseMessage(body)
        await this.broadcastToAll(msg)
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
        })
    }

    private removeStream(entry: StreamEntry): void {
        this.streams = this.streams.filter((s) => s !== entry)
    }

    private async broadcastToAll(data: string): Promise<void> {
        const dead: StreamEntry[] = []
        await Promise.all(
            this.streams.map(async (entry) => {
                try {
                    await entry.write(data)
                } catch {
                    dead.push(entry)
                }
            })
        )
        dead.forEach((entry) => this.removeStream(entry))
    }
}
