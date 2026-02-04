import type {Context} from 'hono'
import type {PlayerIdentity} from '../player/types'
import type {Env} from '../shared/types'

type HonoVars = { user: PlayerIdentity }

/**
 * Middleware that requires the user to be an admin.
 * Returns 403 Forbidden if the user is not an admin.
 */
export async function requireAdmin(
    c: Context<{ Bindings: Env; Variables: HonoVars }>,
    next: () => Promise<void>
) {
    const user = c.get('user')
    
    if (!user.isAdmin) {
        return c.json({ error: 'Forbidden: Admin access required' }, 403)
    }
    
    return next()
}
