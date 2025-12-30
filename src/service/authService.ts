import {createRemoteJWKSet, jwtVerify} from 'jose'
import type {Env} from '../index'

export type AuthUser = { id: string; email: string }

const jwksFor = (supabaseUrl: string) =>
    createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))

export async function verifySupabaseJwt(env: Env, authHeader?: string): Promise<AuthUser> {
    if (!authHeader?.startsWith('Bearer ')) {
        throw new Error('Missing Bearer token')
    }

    const token = authHeader.slice(7)

    const { payload } = await jwtVerify(token, jwksFor(env.SUPABASE_URL), {
        issuer: `${env.SUPABASE_URL}/auth/v1`,
        audience: 'authenticated',
    })

    const sub = payload.sub
    const email = (payload as any).email

    if (typeof sub !== 'string' || typeof email !== 'string') {
        throw new Error('Invalid token payload')
    }

    return { id: sub, email }
}
