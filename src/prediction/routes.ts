import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {checkPredictionEnabled, createOrUpdatePrediction, getPredictionLeaderboard, getUserPrediction,} from './service'
import {getUserCompetitions} from '../player/service'
import {isCompetitionParticipant} from '../metrix/statsService'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

// Get user's prediction for a competition
router.get('/:competitionId', async (c) => {
    const user = c.get('user')
    const competitionId = Number(c.req.param('competitionId'))

    if (!Number.isFinite(competitionId)) {
        return c.json({success: false, error: 'Invalid competition ID'}, 400)
    }

    // Verify user has access to this competition
    const list = await getUserCompetitions(c.env, user.metrixUserId)
    if (!list.some((x) => x.id === competitionId)) {
        return c.json({success: false, error: 'Competition not available for this user'}, 403)
    }

    // Check if user is participating in this competition
    const {data: participates, error: partError} = await isCompetitionParticipant(c.env, competitionId, user.metrixUserId)
    if (partError) {
        return c.json({success: false, error: 'Failed to verify participation'}, 500)
    }
    if (!participates) {
        return c.json({success: false, error: 'Sa ei osale sellel võistlusel', code: 'not_competition_participant'}, 403)
    }

    // Check if prediction is enabled
    const enabledCheck = await checkPredictionEnabled(c.env, competitionId)
    if (enabledCheck.error) {
        return c.json({success: false, error: enabledCheck.error.message}, 500)
    }
    if (!enabledCheck.enabled) {
        return c.json({success: false, error: 'Prediction is not enabled for this competition'}, 403)
    }

    const result = await getUserPrediction(c.env, competitionId, user.playerId)

    if (result.error) {
        return c.json({success: false, error: result.error.message}, 500)
    }

    return c.json({success: true, data: result.data})
})

// Create or update prediction
router.post('/:competitionId', async (c) => {
    const user = c.get('user')
    const competitionId = Number(c.req.param('competitionId'))

    if (!Number.isFinite(competitionId)) {
        return c.json({success: false, error: 'Invalid competition ID'}, 400)
    }

    // Verify user has access to this competition
    const list = await getUserCompetitions(c.env, user.metrixUserId)
    if (!list.some((x) => x.id === competitionId)) {
        return c.json({success: false, error: 'Competition not available for this user'}, 403)
    }

    // Check if user is participating in this competition
    const {data: participates, error: partError} = await isCompetitionParticipant(c.env, competitionId, user.metrixUserId)
    if (partError) {
        return c.json({success: false, error: 'Failed to verify participation'}, 500)
    }
    if (!participates) {
        return c.json({success: false, error: 'Sa ei osale sellel võistlusel', code: 'not_competition_participant'}, 403)
    }

    const body = await c.req.json().catch(() => ({}))

    const result = await createOrUpdatePrediction(c.env, competitionId, user.playerId, body)

    if (result.error) {
        return c.json({success: false, error: result.error.message}, 400)
    }

    return c.json({success: true, data: result.data})
})

// Update existing prediction
router.patch('/:competitionId', async (c) => {
    const user = c.get('user')
    const competitionId = Number(c.req.param('competitionId'))

    if (!Number.isFinite(competitionId)) {
        return c.json({success: false, error: 'Invalid competition ID'}, 400)
    }

    // Verify user has access to this competition
    const list = await getUserCompetitions(c.env, user.metrixUserId)
    if (!list.some((x) => x.id === competitionId)) {
        return c.json({success: false, error: 'Competition not available for this user'}, 403)
    }

    // Check if user is participating in this competition
    const {data: participates, error: partError} = await isCompetitionParticipant(c.env, competitionId, user.metrixUserId)
    if (partError) {
        return c.json({success: false, error: 'Failed to verify participation'}, 500)
    }
    if (!participates) {
        return c.json({success: false, error: 'Sa ei osale sellel võistlusel', code: 'not_competition_participant'}, 403)
    }

    const body = await c.req.json().catch(() => ({}))

    const result = await createOrUpdatePrediction(c.env, competitionId, user.playerId, body)

    if (result.error) {
        return c.json({success: false, error: result.error.message}, 400)
    }

    return c.json({success: true, data: result.data})
})

// Get prediction leaderboard (available even when prediction is disabled)
router.get('/:competitionId/leaderboard', async (c) => {
    const user = c.get('user')
    const competitionId = Number(c.req.param('competitionId'))

    if (!Number.isFinite(competitionId)) {
        return c.json({success: false, error: 'Invalid competition ID'}, 400)
    }

    // Verify user has access to this competition
    const list = await getUserCompetitions(c.env, user.metrixUserId)
    if (!list.some((x) => x.id === competitionId)) {
        return c.json({success: false, error: 'Competition not available for this user'}, 403)
    }

    // Leaderboard is always available, regardless of prediction_enabled status
    // Pass playerId to include user's rank if they have a prediction
    const result = await getPredictionLeaderboard(c.env, competitionId, user.playerId)

    if (result.error) {
        return c.json({success: false, error: result.error.message}, 500)
    }

    return c.json({success: true, data: result.data})
})

export default router
