import {Hono} from 'hono'
import {z} from 'zod'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {verifyCompetitionAccess} from '../shared/competitionAccess'
import {parseJsonBody} from '../shared/validation'
import {buildBillData, findTransaction, normalizeIban, normalizeInstructionId, recordPlayerBillIssued,} from './service'

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

    const iban = normalizeIban(parsed.data.iban)
    const instructionId = normalizeInstructionId(parsed.data.instructionId)
    if (!iban || !instructionId) {
        return c.json(
            {
                success: false,
                code: 'bill_missing_payment_details',
                error: 'Please provide IBAN and payment reference number.',
            },
            400,
        )
    }

    const tx = findTransaction(iban, instructionId)
    if (!tx) {
        return c.json(
            {
                success: false,
                code: 'bill_transaction_not_found',
                error: 'Payment not found. Check IBAN and payment reference.',
            },
            404,
        )
    }

    const bill = buildBillData(tx, competitionId, user.playerId)
    await recordPlayerBillIssued(c.env, user.playerId, bill.billNumber)
    return c.json({success: true, data: bill})
})

export default router
