import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {submitFeedback} from './service'
import {feedbackBodySchema, parseJsonBody} from '../shared/validation'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.post('/', async (c) => {
    const parsed = await parseJsonBody(() => c.req.json(), feedbackBodySchema)
    if (!parsed.success) return c.json({error: parsed.error}, 400)

    const {score, feedback} = parsed.data

    const {data, error} = await submitFeedback(c.env, score, feedback)

    if (error) {
        return c.json({error}, 500)
    }

    return c.json({success: true, data})
})

export default router
