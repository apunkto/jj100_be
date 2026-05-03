import {DurableObject} from 'cloudflare:workers'
import type {Env} from '../shared/types'
import type {LedScreenStateValue} from './ledScreenState'
import {getLedScreenState} from './ledScreenState'
import {base64DecodeUtf8} from '../lottery/base64'

const INITIAL_STATE_HEADER = 'X-Initial-Led-Screen-State'
const COMPETITION_ID_HEADER = 'X-Competition-Id'

type DurableObjectIdLike = {name?: string; toString(): string}

const HEARTBEAT_INTERVAL_MS = 60_000

type StreamEntry = {
    write: (data: string) => Promise<void>
    close: () => void
}

function parseCompetitionIdFromDoId(id: DurableObjectIdLike): number | null {
    let name: string | undefined
    if ('name' in id && typeof id.name === 'string') {
        name = id.name
    } else {
        const str = id.toString()
        if (str.includes('led-screen-')) {
            name = str
        } else {
            console.error('[LedScreenControlDO] Unable to parse competition ID from:', {id, name: id.name, toString: str})
            return null
        }
    }

    const prefix = 'led-screen-'
    if (!name.startsWith(prefix)) {
        console.error('[LedScreenControlDO] ID name does not start with expected prefix:', {name, prefix})
        return null
    }

    const num = name.slice(prefix.length)
    const parsed = parseInt(num, 10)
    if (isNaN(parsed)) {
        console.error('[LedScreenControlDO] Failed to parse competition ID number:', {name, num})
        return null
    }

    return parsed
}

function sseMessage(data: LedScreenStateValue): string {
    return `data: ${JSON.stringify(data)}\n\n`
}

export class LedScreenControlDO extends DurableObject<Env> {
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
        return new Response('Not Found', {status: 404})
    }

    private async handleGet(request: Request): Promise<Response> {
        let competitionId: number | null = null
        const competitionIdHeader = request.headers.get(COMPETITION_ID_HEADER)
        if (competitionIdHeader) {
            const parsed = parseInt(competitionIdHeader, 10)
            if (!isNaN(parsed)) {
                competitionId = parsed
            }
        }

        if (competitionId === null) {
            competitionId = parseCompetitionIdFromDoId(this.ctx.id)
        }

        if (competitionId === null) {
            return new Response(JSON.stringify({error: 'Invalid competition'}), {
                status: 400,
                headers: {'Content-Type': 'application/json'},
            })
        }

        const encoder = new TextEncoder()
        const {readable, writable} = new TransformStream<Uint8Array, Uint8Array>()
        const writer = writable.getWriter()

        const write = async (data: string) => {
            await writer.write(encoder.encode(data))
        }

        const close = () => {
            this.removeStream(entry)
            writer.close().catch(() => {})
        }

        const entry: StreamEntry = {write, close}
        this.streams.push(entry)

        const initialStateHeader = request.headers.get(INITIAL_STATE_HEADER)
        let state: LedScreenStateValue | null = null
        if (initialStateHeader) {
            try {
                state = JSON.parse(base64DecodeUtf8(initialStateHeader)) as LedScreenStateValue
            } catch {
                // ignore
            }
        }

        this.ctx.waitUntil(
            (async () => {
                try {
                    const resolvedState = state ?? (await getLedScreenState(this.env, competitionId!))
                    await write(sseMessage(resolvedState))
                } catch {
                    await write(
                        sseMessage({
                            board: 'main',
                            leaderboardDivision: null,
                        })
                    ).catch(() => {})
                }
                if (!this.heartbeatTimer) {
                    const scheduleNext = (): void => {
                        this.heartbeatTimer = setTimeout(async () => {
                            try {
                                await this.broadcastToAll(': heartbeat\n\n')
                            } catch (err) {
                                console.error('[LedScreenControlDO] heartbeat broadcast error:', err)
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
        let body: LedScreenStateValue
        try {
            body = (await request.json()) as LedScreenStateValue
        } catch {
            return new Response('Invalid JSON', {status: 400})
        }
        const msg = sseMessage(body)
        await this.broadcastToAll(msg)
        return new Response(JSON.stringify({success: true}), {
            headers: {'Content-Type': 'application/json'},
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
