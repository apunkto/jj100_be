import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {checkPredictionEnabled, createOrUpdatePrediction, getPredictionLeaderboard, getUserPrediction,} from './service'
import {isCompetitionParticipant} from '../metrix/statsService'
import {getSupabaseClient} from '../shared/supabase'
import {verifyCompetitionAccess} from '../shared/competitionAccess'
import {parseJsonBody, predictionBodySchema} from '../shared/validation'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

// Get user's prediction for a competition
// This endpoint allows fetching predictions even when prediction_enabled is false
// Only creating/updating predictions is restricted when disabled
router.get('/:competitionId', async (c) => {
    const user = c.get('user')
    const competitionId = Number(c.req.param('competitionId'))

    if (!Number.isFinite(competitionId)) {
        return c.json({success: false, error: 'Invalid competition ID'}, 400)
    }

    // Verify user has access to this competition
    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        if (accessCheck.status === 403) {
            return c.json({success: false, error: accessCheck.error}, 403)
        } else if (accessCheck.status === 404) {
            return c.json({success: false, error: accessCheck.error}, 404)
        } else {
            return c.json({success: false, error: accessCheck.error}, 500)
        }
    }

    // Check if user is participating in this competition
    const {data: participates, error: partError} = await isCompetitionParticipant(c.env, competitionId, user.metrixUserId)
    if (partError) {
        return c.json({success: false, error: 'Failed to verify participation'}, 500)
    }
    if (!participates) {
        return c.json({success: false, error: 'Sa ei osale sellel võistlusel', code: 'not_competition_participant'}, 403)
    }

    // Note: We don't check prediction_enabled here - users can view their predictions even when disabled
    // Only creating/updating is restricted when prediction_enabled is false

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
    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        if (accessCheck.status === 403) {
            return c.json({success: false, error: accessCheck.error}, 403)
        } else if (accessCheck.status === 404) {
            return c.json({success: false, error: accessCheck.error}, 404)
        } else {
            return c.json({success: false, error: accessCheck.error}, 500)
        }
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

    const parsed = await parseJsonBody(() => c.req.json(), predictionBodySchema)
    if (!parsed.success) return c.json({success: false, error: parsed.error}, 400)

    const result = await createOrUpdatePrediction(c.env, competitionId, user.playerId, parsed.data)

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
    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        if (accessCheck.status === 403) {
            return c.json({success: false, error: accessCheck.error}, 403)
        } else if (accessCheck.status === 404) {
            return c.json({success: false, error: accessCheck.error}, 404)
        } else {
            return c.json({success: false, error: accessCheck.error}, 500)
        }
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

    const parsed = await parseJsonBody(() => c.req.json(), predictionBodySchema)
    if (!parsed.success) return c.json({success: false, error: parsed.error}, 400)

    const result = await createOrUpdatePrediction(c.env, competitionId, user.playerId, parsed.data)

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
    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        if (accessCheck.status === 403) {
            return c.json({success: false, error: accessCheck.error}, 403)
        } else if (accessCheck.status === 404) {
            return c.json({success: false, error: accessCheck.error}, 404)
        } else {
            return c.json({success: false, error: accessCheck.error}, 500)
        }
    }

    // Leaderboard is always available, regardless of prediction_enabled status
    // Pass playerId to include user's rank if they have a prediction
    const result = await getPredictionLeaderboard(c.env, competitionId, user.playerId)

    if (result.error) {
        return c.json({success: false, error: result.error.message}, 500)
    }

    return c.json({success: true, data: result.data})
})

// Get another player's prediction by player ID
router.get('/:competitionId/player/:playerId', async (c) => {
    const user = c.get('user')
    const competitionId = Number(c.req.param('competitionId'))
    const targetPlayerId = Number(c.req.param('playerId'))

    if (!Number.isFinite(competitionId) || !Number.isFinite(targetPlayerId)) {
        return c.json({success: false, error: 'Invalid competition ID or player ID'}, 400)
    }

    // Verify user has access to this competition
    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        if (accessCheck.status === 403) {
            return c.json({success: false, error: accessCheck.error}, 403)
        } else if (accessCheck.status === 404) {
            return c.json({success: false, error: accessCheck.error}, 404)
        } else {
            return c.json({success: false, error: accessCheck.error}, 500)
        }
    }

    // Fetch player data (name + metrix_user_id) first, then use it to optimize prediction fetch
    const supabase = getSupabaseClient(c.env)
    const {data: playerData} = await supabase
        .from('player')
        .select('name, metrix_user_id')
        .eq('id', targetPlayerId)
        .maybeSingle()

    const playerName = playerData?.name || 'Tundmatu mängija'
    const metrixUserId = playerData?.metrix_user_id ? Number(playerData.metrix_user_id) : undefined

    // Get the target player's prediction (pass metrixUserId to avoid duplicate lookup)
    const result = await getUserPrediction(c.env, competitionId, targetPlayerId, metrixUserId)

    if (result.error) {
        return c.json({success: false, error: result.error.message}, 500)
    }

    return c.json({
        success: true,
        data: {
            prediction: result.data,
            player_name: playerName,
        },
    })
})

export default router
