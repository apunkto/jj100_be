import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {getUserResultOnHole} from '../metrix/service'
import {
    getCtpByHoleNumber,
    getCtpHoles,
    getHoleByNumber,
    getHoleCount,
    getHoles,
    getTopRankedHoles,
    submitCtpResult
} from './service'
import {resolveCompetitionId} from '../shared/competitionAccess'
import {jsonError} from '../shared/responses'
import {ctpBodySchema, parseJsonBody} from '../shared/validation'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.get('/hole/:number', async (c) => {
    const user = c.get('user')
    const competitionId = resolveCompetitionId(c.req.query('competitionId'), user.activeCompetitionId)
    if (competitionId == null) return jsonError(c, 'No active competition', 400)
    const holeNumber = Number(c.req.param('number'))

    const [holeRes, userRes] = await Promise.all([
        getHoleByNumber(c.env, holeNumber, competitionId),
        getUserResultOnHole(c.env, competitionId, String(user.metrixUserId), holeNumber),
    ])
    const { data, error } = holeRes
    const { data: userHoleResult } = userRes

    if (error) return jsonError(c, error, 400)
    if (!data?.hole) return c.json(data, 200, { 'Cache-Control': 'private, max-age=60, must-revalidate' })
    const payload = {
        hole: {
            ...data.hole,
            user_result: userHoleResult?.result ?? null,
            user_has_penalty: userHoleResult?.hasPenalty ?? false,
        },
    }
    return c.json(payload, 200, {
        'Cache-Control': 'private, max-age=60, must-revalidate',
    })
})

router.get('/hole/:number/ctp', async (c) => {
    const user = c.get('user')
    const competitionId = resolveCompetitionId(c.req.query('competitionId'), user.activeCompetitionId)
    if (competitionId == null) return jsonError(c, 'No active competition', 400)
    const holeNumber = Number(c.req.param('number'))
    const { data, error } = await getCtpByHoleNumber(c.env, holeNumber, competitionId)

    if (error) return jsonError(c, error, 400)

    return c.json(data ?? [], 200, {
        "Cache-Control": "private, max-age=0, must-revalidate"
    })
})

router.post('/ctp/:hole', async (c) => {
    const hole = Number(c.req.param('hole'))
    const parsed = await parseJsonBody(() => c.req.json(), ctpBodySchema)
    if (!parsed.success) return jsonError(c, parsed.error, 400)

    const user = c.get('user')
    if (user.activeCompetitionId == null) return jsonError(c, 'No active competition', 400)

    const {data, error} = await submitCtpResult(c.env, hole, user.playerId, user.metrixUserId, parsed.data.distance_cm, user.activeCompetitionId)

    if (error) {
        const status =
            error.code === "ctp_already_submitted" ? 409 :
                error.code === "ctp_too_far" ? 422 :
                    error.code === "not_ctp_hole" ? 400 :
                        error.code === "hole_not_found" ? 404 :
                            error.code === "ctp_disabled" ? 403 :
                                error.code === "not_competition_participant" ? 403 :
                                    400

        return jsonError(c, error, status)
    }

    return c.json({ success: true, data, error: null })
})

router.get('/holes/ctp', async (c) => {
    const user = c.get('user')
    if (user.activeCompetitionId == null || !Number.isFinite(user.activeCompetitionId)) {
        return jsonError(c, 'No active competition', 400)
    }

    const {data, error} = await getCtpHoles(c.env, user.activeCompetitionId)

    if (error) return jsonError(c, error, 500)

    return c.json(data ?? []);
});

router.get('/holes/count', async (c) => {
    const user = c.get('user')
    const competitionId = resolveCompetitionId(c.req.query('competitionId'), user.activeCompetitionId)
    if (competitionId == null) return jsonError(c, 'No active competition', 400)
    const {data, error} = await getHoleCount(c.env, competitionId)
    if (error) return jsonError(c, error, 400)
    return c.json({count: data ?? 0}, 200, {
        'Cache-Control': 'private, max-age=86400, must-revalidate',
    })
})

router.get('/holes/top-ranked', async (c) => {
    const user = c.get('user')
    const competitionId = resolveCompetitionId(c.req.query('competitionId'), user.activeCompetitionId)

    const {data, error} = await getTopRankedHoles(c.env, competitionId)

    if (error) return jsonError(c, error, 500)

    return c.json(data)
})

router.get('/holes', async (c) => {
    const user = c.get('user')
    const competitionId = resolveCompetitionId(c.req.query('competitionId'), user.activeCompetitionId)

    const {data, error} = await getHoles(c.env, competitionId)

    if (error) return jsonError(c, error, 500)

    return c.json(data)
})

export default router
