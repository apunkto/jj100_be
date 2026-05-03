import {z} from 'zod'

/** Parse and validate JSON body. Returns parsed data or error message. */
export async function parseJsonBody<T>(
    parse: () => Promise<unknown>,
    schema: z.ZodType<T>
): Promise<{ success: true; data: T } | { success: false; error: string }> {
    let raw: unknown
    try {
        raw = await parse()
    } catch {
        return {success: false, error: 'Invalid JSON'}
    }
    const result = schema.safeParse(raw)
    if (result.success) {
        return {success: true, data: result.data}
    }
    const first = result.error.issues[0]
    const msg = first ? `${first.path.join('.')}: ${first.message}` : 'Validation failed'
    return {success: false, error: msg}
}

// Admin competition flag (enabled boolean)
export const adminEnabledSchema = z.object({enabled: z.boolean()})

// Admin did-rain: accepts did_rain (preferred) or enabled for backward compatibility
export const adminDidRainSchema = z
    .object({
        did_rain: z.boolean().optional(),
        enabled: z.boolean().optional(),
    })
    .refine((d) => d.did_rain !== undefined || d.enabled !== undefined, 'did_rain or enabled required')
    .transform((d) => ({ did_rain: d.did_rain ?? d.enabled! }))

// Admin competition status
export const adminStatusSchema = z.object({
    status: z.enum(['waiting', 'started', 'finished']),
})

// Prediction body (optional fields for partial updates)
export const predictionBodySchema = z.object({
    best_overall_score: z.number().optional().nullable(),
    best_female_score: z.number().optional().nullable(),
    will_rain: z.boolean().optional().nullable(),
    player_own_score: z.number().optional().nullable(),
    hole_in_ones_count: z.number().optional().nullable(),
    water_discs_count: z.number().optional().nullable(),
}).passthrough()

// Food choices (Toitlustus)
export const foodChoicesPatchSchema = z.object({
    is_vege_food: z.boolean(),
    pizza: z.enum(['tyri', 'mafioso', 'vegetariana']),
})

// CTP submission
export const ctpBodySchema = z.object({
    distance_cm: z.number().int().nonnegative(),
    target_metrix_player_result_id: z.number().int().positive().optional(),
})

// Feedback
export const feedbackBodySchema = z.object({
    score: z.number().int().min(1).max(5),
    feedback: z.string().min(1).transform((s) => s.trim()),
})

// Auth pre-login — set fetchMetrixIfNewUser true only after user consents to Metrix data use
export const authPreLoginSchema = z.object({
    email: z.string().email().transform((s) => s.trim().toLowerCase()),
    fetchMetrixIfNewUser: z.boolean().optional(),
})

// Auth register-from-metrix
export const authRegisterSchema = z.object({
    email: z.string().email().transform((s) => s.trim().toLowerCase()),
    metrixUserId: z.number().int().positive(),
})

/** LED wall remote control */
export const ledScreenSelectSchema = z.object({
    board: z.enum(['main', 'leaderboard', 'draw', 'finalDraw', 'finalPutting']),
    leaderboardDivision: z
        .union([z.string(), z.null()])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : String(v).trim() || null)),
    leaderboardPanel: z.enum(['division', 'prediction']).optional(),
})
