import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from './types'
import {getParticipationLeaderboard, getUserCompetitions, getUserParticipation, resolvePlayerIdentity} from './service'
import {getSupabaseClient} from '../shared/supabase'
import {verifyCompetitionAccess} from '../shared/competitionAccess'
import {getPlayerResult} from '../metrix/statsService'
import {foodChoicesPatchSchema, parseJsonBody} from '../shared/validation'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.get('/competitions', async (c) => {
    const user = c.get('user')
    const list = await getUserCompetitions(c.env, user.metrixUserId)
    return c.json({ success: true, data: list })
})

router.patch('/active-competition', async (c) => {
    const user = c.get('user')
    const body = await c.req.json<{ activeCompetitionId?: number }>()
    const activeCompetitionId = body.activeCompetitionId
    if (activeCompetitionId == null || !Number.isFinite(activeCompetitionId)) {
        return c.json({ success: false, error: 'Invalid activeCompetitionId' }, 400)
    }

    const accessCheck = await verifyCompetitionAccess(c.env, user, activeCompetitionId)
    if (!accessCheck.success) {
        const status = (accessCheck.status === 403 ? 400 : accessCheck.status) as 400 | 404 | 500
        return c.json({ success: false, error: accessCheck.error }, status)
    }

    const supabase = getSupabaseClient(c.env)
    const { error } = await supabase
        .from('player')
        .update({ active_competition_id: activeCompetitionId })
        .eq('id', user.playerId)
    if (error) return c.json({ success: false, error: error.message }, 500)
    const identity = await resolvePlayerIdentity(c.env, user.email)
    return c.json({ success: true, data: identity })
})

router.get('/participations', async (c) => {
    const user = c.get('user')
    const userMetrixId = user.metrixUserId
    if (!userMetrixId) return c.json({error: 'Invalid metrixUserId'}, 400)

    const participations = await getUserParticipation(c.env, userMetrixId)

    return c.json(
        {success: true, data: participations},
        200,
        {
            "Cache-Control": "private, max-age=604800, stale-while-revalidate=86400",
        }
    )
})

router.get("/participations/leaders", async (c) => {
    const cache = await caches.open("leaders-cache")

    // stable key, not tied to incoming headers
    const cacheKey = new Request("https://cache.local/leadersV1", {method: "GET"})

    const hit = await cache.match(cacheKey)
    console.log("Cache lookup:", hit ? "HIT" : "MISS")
    if (hit) return hit

    const leaderboard = await getParticipationLeaderboard(c.env)

    const res = c.json({success: true, data: leaderboard})

    // Make response cacheable + CORS that doesn't vary
    res.headers.set("Cache-Control", "public, max-age=86400, s-maxage=2592000")
    res.headers.set("Access-Control-Allow-Origin", "*")
    res.headers.set("Access-Control-Allow-Methods", "GET,OPTIONS")
    res.headers.delete("Vary") // important if your framework added Vary: Origin

    await cache.put(cacheKey, res.clone())
    return res
})

router.get('/food-choices', async (c) => {
    const user = c.get('user')
    const competitionId = user.activeCompetitionId
    if (competitionId == null || !Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'No active competition' }, 400)
    }

    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        return c.json(
            { success: false, error: accessCheck.error },
            accessCheck.status as 400 | 403 | 404 | 500
        )
    }

    const { data, error } = await getPlayerResult(c.env, competitionId, String(user.metrixUserId))
    if (error) return c.json({ success: false, error: error.message }, 500)
    if (!data) {
        return c.json({ success: true, data: null }, 200, {
            'Cache-Control': 'private, max-age=0, must-revalidate',
        })
    }

    const is_vege_food = data.is_vege_food ?? false
    const pizza = data.pizza ?? null
    return c.json(
        { success: true, data: { is_vege_food, pizza } },
        200,
        { 'Cache-Control': 'private, max-age=0, must-revalidate' }
    )
})

router.patch('/food-choices', async (c) => {
    const user = c.get('user')
    const competitionId = user.activeCompetitionId
    if (competitionId == null || !Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'No active competition' }, 400)
    }

    const accessCheck = await verifyCompetitionAccess(c.env, user, competitionId)
    if (!accessCheck.success) {
        return c.json(
            { success: false, error: accessCheck.error },
            accessCheck.status as 400 | 403 | 404 | 500
        )
    }

    const supabase = getSupabaseClient(c.env)
    const { data: comp, error: compErr } = await supabase
        .from('metrix_competition')
        .select('food_choice_enabled')
        .eq('id', competitionId)
        .maybeSingle()

    if (compErr) return c.json({ success: false, error: compErr.message }, 500)
    if (!comp?.food_choice_enabled) {
        return c.json(
            {
                success: false,
                error: 'Food choice updates are disabled for this competition',
                code: 'food_choice_disabled',
            },
            403
        )
    }

    const parsed = await parseJsonBody(() => c.req.json(), foodChoicesPatchSchema)
    if (!parsed.success) return c.json({ success: false, error: parsed.error }, 400)

    const { data: row, error: rowErr } = await getPlayerResult(c.env, competitionId, String(user.metrixUserId))
    if (rowErr) return c.json({ success: false, error: rowErr.message }, 500)
    if (!row?.id) {
        return c.json(
            { success: false, error: 'No player result for this competition', code: 'player_result_not_found' },
            404
        )
    }

    const { error: updErr } = await supabase
        .from('metrix_player_result')
        .update({
            is_vege_food: parsed.data.is_vege_food,
            pizza: parsed.data.pizza,
        })
        .eq('id', row.id)

    if (updErr) return c.json({ success: false, error: updErr.message }, 500)

    return c.json({
        success: true,
        data: { is_vege_food: parsed.data.is_vege_food, pizza: parsed.data.pizza },
        error: null,
    })
})

export default router
