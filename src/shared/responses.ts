import type {Context} from 'hono'

type HttpStatus = 200 | 400 | 403 | 404 | 409 | 422 | 500 | number

/** Standard API success: { success: true, data, error: null } */
export type ApiSuccess<T> = { success: true; data: T; error: null }

/** Standard API error: { success: false, data: null, error } */
export type ApiError = {
    success: false
    data: null
    error: string | { message: string; code?: string }
}

/** Standard API response shape */
export type ApiResponse<T> = ApiSuccess<T> | ApiError

/** Return standard success JSON. */
export function jsonSuccess<T>(
    c: Context,
    data: T,
    status: HttpStatus = 200,
    headers?: Record<string, string>
) {
    if (headers) {
        return c.json({ success: true, data, error: null } as ApiSuccess<T>, status as 200, headers)
    }
    return c.json({ success: true, data, error: null } as ApiSuccess<T>, status as 200)
}

/** Return standard error JSON. */
export function jsonError(
    c: Context,
    error: string | { message: string; code?: string },
    status: HttpStatus = 400
) {
    const err = typeof error === 'string' ? { message: error } : error
    return c.json({ success: false, data: null, error: err } as ApiError, status as 400)
}
