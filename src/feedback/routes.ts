import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {submitFeedback} from './service'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.post('/', async (c) => {
    const body = await c.req.json<{ score: number; feedback: string }>()

    const {score, feedback} = body

    if (isNaN(score) || score < 1 || score > 5 || !feedback.trim()) {
        return c.json({error: 'Invalid score or feedback'}, 400)
    }

    const {data, error} = await submitFeedback(c.env, score, feedback)

    if (error) {
        return c.json({error}, 500)
    }

    return c.json({success: true, data})
})

export default router
