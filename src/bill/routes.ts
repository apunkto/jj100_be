import {Hono} from 'hono'
import {z} from 'zod'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {verifyCompetitionAccess} from '../shared/competitionAccess'
import {parseJsonBody} from '../shared/validation'
import {buildBillData, findTransaction} from './service'

type HonoVars = {user: PlayerIdentity}
const router = new Hono<{Bindings: Env; Variables: HonoVars}>()

const billLookupSchema = z.object({
    iban: z.string().min(1, 'IBAN is required'),
    instructionId: z.string().min(1, 'Instruction ID is required'),
})

router.post('/lookup', async (c) => {
    const user = c.get('user')
    const competitionId = user.activeCompetitionId
    if (competitionId == null || !Number.isFinite(competitionId)) {
        return c.json({success: false, error: 'No active competition'}, 400)
    }

    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        return c.json(
            {success: false, error: accessCheck.error},
            accessCheck.status as 400 | 403 | 404 | 500,
        )
    }

    const parsed = await parseJsonBody(() => c.req.json(), billLookupSchema)
    if (!parsed.success) return c.json({success: false, error: parsed.error}, 400)

    const tx = findTransaction(parsed.data.iban, parsed.data.instructionId)
    if (!tx) {
        return c.json(
            {success: false, error: 'Makset ei leitud. Kontrolli pangakonto numbrit ja maksekorralduse numbrit.'},
            404,
        )
    }

    const bill = buildBillData(tx, competitionId, user.playerId)
    return c.json({success: true, data: bill})
})

export default router
