import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {checkPlayerExistsByEmail} from '../player/service'
import {cacheMetrixIdentities, fetchMetrixIdentityByEmail, getCachedMetrixIdentities} from '../metrix/service'
import {getSupabaseClient} from '../shared/supabase'
import {authPreLoginSchema, authRegisterSchema, parseJsonBody} from '../shared/validation'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.post('/pre-login', async (c) => {
    const parsed = await parseJsonBody(() => c.req.json(), authPreLoginSchema)
    if (!parsed.success) return c.json({success: false, error: parsed.error}, 400)
    const email = parsed.data.email

    // Check if player exists in DB
    const inDb = await checkPlayerExistsByEmail(c.env, email)

    if (inDb) {
        return c.json({success: true, data: {inDb: true}})
    }

    // Not in DB: fetch from Metrix and cache
    const identities = await fetchMetrixIdentityByEmail(email)
    await cacheMetrixIdentities(email, identities)

    return c.json({success: true, data: {inDb: false, identities}})
})

router.post('/register-from-metrix', async (c) => {
    const parsed = await parseJsonBody(() => c.req.json(), authRegisterSchema)
    if (!parsed.success) return c.json({success: false, error: parsed.error}, 400)
    const {email, metrixUserId} = parsed.data

    // Try cache first
    let identities = await getCachedMetrixIdentities(email)
    
    // If cache miss, fetch from Metrix (fallback)
    if (!identities) {
        identities = await fetchMetrixIdentityByEmail(email)
        // Optionally write back to cache for retries
        await cacheMetrixIdentities(email, identities)
    }

    // Verify metrixUserId is in the list
    const chosen = identities.find((id) => id.userId === metrixUserId)
    if (!chosen) {
        return c.json({success: false, error: 'Invalid email or Metrix user'}, 400)
    }

    // Upsert player
    const supabase = getSupabaseClient(c.env)
    const {error} = await supabase
        .from('player')
        .upsert(
            {
                email: email,
                metrix_user_id: chosen.userId,
                name: chosen.name,
            },
            {onConflict: 'metrix_user_id'}
        )

    if (error) {
        return c.json({success: false, error: error.message}, 500)
    }

    return c.json({success: true})
})

export default router
