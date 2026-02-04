import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from './types'
import {getParticipationLeaderboard, getUserCompetitions, getUserParticipation, resolvePlayerIdentity} from './service'
import {getSupabaseClient} from '../shared/supabase'

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
    const list = await getUserCompetitions(c.env, user.metrixUserId)
    if (!list.some((x) => x.id === activeCompetitionId)) {
        return c.json({ success: false, error: 'Competition not available for this user' }, 400)
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

export default router
