"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const cors_1 = require("hono/cors");
const ctpService_1 = require("./service/ctpService");
const playerService_1 = require("./service/playerService");
const checkinService_1 = require("./service/checkinService");
const configService_1 = require("./service/configService");
const feedbackService_1 = require("./service/feedbackService");
const metrixService_1 = require("./service/metrixService");
const metrixStatsService_1 = require("./service/metrixStatsService");
const authService_1 = require("./service/authService");
const supabase_1 = require("./supabase");
const PUBLIC_PATHS = [
    /^\/metrix\/check-email$/,
    /^\/auth\/pre-login$/,
    /^\/auth\/register-from-metrix$/,
    /^\/debug\/run-metrix$/,
];
const app = new hono_1.Hono();
app.use('*', (0, cors_1.cors)({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS', 'DELETE'],
}));
app.use('*', (c, next) => __awaiter(void 0, void 0, void 0, function* () {
    // CORS preflight must pass
    if (c.req.method === 'OPTIONS')
        return next();
    // Public endpoints
    if (PUBLIC_PATHS.some((re) => re.test(c.req.path)))
        return next();
    // Everything else requires auth
    try {
        const { email } = yield (0, authService_1.verifySupabaseJwt)(c.env, c.req.header('Authorization'));
        const identity = yield (0, playerService_1.resolvePlayerIdentity)(c.env, email);
        c.set('user', identity);
        return next();
    }
    catch (err) {
        console.error('Auth error:', err);
        return c.json({ error: 'Unauthorized' }, 401);
    }
}));
app.get('/hole/:number', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    const competitionIdParam = c.req.query('competitionId');
    const competitionId = competitionIdParam != null && competitionIdParam !== ''
        ? Number(competitionIdParam)
        : user.activeCompetitionId;
    if (competitionId == null || !Number.isFinite(competitionId))
        return c.json({ error: 'No active competition' }, 400);
    const holeNumber = Number(c.req.param('number'));
    const { data, error } = yield (0, ctpService_1.getHoleByNumber)(c.env, holeNumber, competitionId);
    if (error)
        return c.json({ error }, 400);
    return c.json(data, 200, {
        "Cache-Control": "private, max-age=60, must-revalidate"
    });
}));
app.get('/hole/:number/ctp', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    const competitionIdParam = c.req.query('competitionId');
    const competitionId = competitionIdParam != null && competitionIdParam !== ''
        ? Number(competitionIdParam)
        : user.activeCompetitionId;
    if (competitionId == null || !Number.isFinite(competitionId))
        return c.json({ error: 'No active competition' }, 400);
    const holeNumber = Number(c.req.param('number'));
    const { data, error } = yield (0, ctpService_1.getCtpByHoleNumber)(c.env, holeNumber, competitionId);
    if (error)
        return c.json({ error }, 400);
    return c.json(data !== null && data !== void 0 ? data : [], 200, {
        "Cache-Control": "private, max-age=0, must-revalidate"
    });
}));
app.post('/ctp/:hole', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const hole = Number(c.req.param('hole'));
    const { distance_cm } = yield c.req.json();
    const user = c.get('user');
    const metrixId = user.activeCompetitionId != null ? yield (0, playerService_1.getMetrixCompetitionId)(c.env, user.activeCompetitionId) : null;
    if (metrixId == null)
        return c.json({ success: false, data: null, error: { message: 'No active competition' } }, 400);
    const { data, error } = yield (0, ctpService_1.submitCtpResult)(c.env, hole, user.playerId, user.metrixUserId, distance_cm, metrixId);
    if (error) {
        const status = error.code === "ctp_already_submitted" ? 409 :
            error.code === "ctp_too_far" ? 422 :
                error.code === "not_ctp_hole" ? 400 :
                    error.code === "hole_not_found" ? 404 :
                        error.code === "ctp_disabled" ? 403 :
                            error.code === "not_competition_participant" ? 403 :
                                400;
        return c.json({ success: false, data: null, error }, status);
    }
    return c.json({ success: !error, data, error });
}));

app.post('/lottery/checkin', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    if (user.activeCompetitionId == null)
        return c.json({ error: 'No active competition' }, 400);
    const metrixId = yield (0, playerService_1.getMetrixCompetitionId)(c.env, user.activeCompetitionId);
    if (metrixId == null)
        return c.json({ error: 'No active competition' }, 400);
    try {
        yield (0, checkinService_1.checkInPlayer)(c.env, user.playerId, user.metrixUserId, metrixId, user.activeCompetitionId);
        return c.json({ success: true });
    }
    catch (err) {
        if (err.status === 409) {
            return c.json({ error: 'Player already checked in' }, 409);
        }
        if (err.code === 'not_competition_participant') {
            return c.json({ error: err.message, code: err.code }, 403);
        }
        return c.json({ error: err.message || 'Internal Server Error' }, 500);
    }
}));
app.get("/lottery/checkin/me", (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get("user");
    if (user.activeCompetitionId == null)
        return c.json({ error: 'No active competition' }, 400);
    const { data, error } = yield (0, checkinService_1.getMyCheckin)(c.env, user.playerId, user.activeCompetitionId);
    if (error) {
        return c.json({ success: false, data: null, error }, 500);
    }
    // if not checked in, data will be null
    return c.json({
        success: true,
        data: { checkedIn: Boolean(data) },
        error: null,
    });
}));

app.delete("/lottery/checkin/me", (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get("user");
    if (user.activeCompetitionId == null)
        return c.json({ error: 'No active competition' }, 400);
    const { data, error } = yield (0, checkinService_1.getMyCheckin)(c.env, user.playerId, user.activeCompetitionId);
    if (error) {
        return c.json({ success: false, error: 'Failed to retrieve check-in' }, 500);
    }
    if (!data) {
        return c.json({ success: false, error: 'Player is not checked in' }, 400);
    }
    const deleteResult = yield (0, checkinService_1.deleteCheckinPlayer)(c.env, data.id);
    if (deleteResult.error) {
        return c.json({ success: false, error: 'Failed to delete check-in' }, 500);
    }
    return c.json({ success: true });
}));
app.get("/me", (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get("user");
    return c.json({
        success: true,
        data: user,
        error: null
    });
}));
app.get('/player/competitions', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    const list = yield (0, playerService_1.getUserCompetitions)(c.env, user.metrixUserId);
    return c.json({ success: true, data: list });
}));
app.patch('/player/active-competition', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    const body = yield c.req.json();
    const activeCompetitionId = body.activeCompetitionId;
    if (activeCompetitionId == null || !Number.isFinite(activeCompetitionId)) {
        return c.json({ success: false, error: 'Invalid activeCompetitionId' }, 400);
    }
    const list = yield (0, playerService_1.getUserCompetitions)(c.env, user.metrixUserId);
    if (!list.some((x) => x.id === activeCompetitionId)) {
        return c.json({ success: false, error: 'Competition not available for this user' }, 400);
    }
    const supabase = (0, supabase_1.getSupabaseClient)(c.env);
    const { error } = yield supabase
        .from('player')
        .update({ active_competition_id: activeCompetitionId })
        .eq('id', user.playerId);
    if (error)
        return c.json({ success: false, error: error.message }, 500);
    const identity = yield (0, playerService_1.resolvePlayerIdentity)(c.env, user.email);
    return c.json({ success: true, data: identity });
}));
app.get('/holes/ctp', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const { data, error } = yield (0, ctpService_1.getCtpHoles)(c.env);
    if (error) {
        return c.json({ error }, 500);
    }
    return c.json(data !== null && data !== void 0 ? data : []);
}));
app.get('/holes/count', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    const competitionIdParam = c.req.query('competitionId');
    const competitionId = competitionIdParam != null && competitionIdParam !== ''
        ? Number(competitionIdParam)
        : user.activeCompetitionId;
    if (competitionId == null || !Number.isFinite(competitionId))
        return c.json({ error: 'No active competition' }, 400);
    const { data, error } = yield (0, ctpService_1.getHoleCount)(c.env, competitionId);
    if (error)
        return c.json({ error }, 400);
    return c.json({ count: data !== null && data !== void 0 ? data : 0 }, 200, {
        'Cache-Control': 'private, max-age=86400, must-revalidate',
    });
}));
app.get('/config/:key', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const { key } = c.req.param();
    const result = yield (0, configService_1.getConfigValue)(c.env, key);
    if (result.error) {
        return c.json({ error: result.error }, 404);
    }
    return c.json({ value: result.data });
}));
app.get('/lottery/checkins', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    if (user.activeCompetitionId == null)
        return c.json({ error: 'No active competition' }, 400);
    const { data, error } = yield (0, checkinService_1.getCheckedInPlayers)(c.env, user.activeCompetitionId);
    if (error) {
        return c.json({ error }, 500);
    }
    return c.json({ success: true, data });
}));
app.post('/lottery/draw', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    if (user.activeCompetitionId == null)
        return c.json({ error: 'No active competition' }, 400);
    const finalGame = c.req.query('final_game') === 'true';
    const { data, error } = yield (0, checkinService_1.drawRandomWinner)(c.env, user.activeCompetitionId, finalGame);
    if (error) {
        return c.json({ error }, 400);
    }
    return c.json(data);
}));
app.post('/lottery/checkin/final/:checkinId', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    if (user.activeCompetitionId == null)
        return c.json({ error: 'No active competition' }, 400);
    const checkinId = Number(c.req.param('checkinId'));
    const { error } = yield (0, checkinService_1.confirmFinalGamePlayer)(c.env, checkinId, user.activeCompetitionId);
    if (error) {
        return c.json({ error: error.message }, 500);
    }
    return c.json({ success: true });
}));
// Delete player
app.delete('/lottery/checkin/:checkinId', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const checkinId = Number(c.req.param('checkinId'));
    const { error } = yield (0, checkinService_1.deleteCheckinPlayer)(c.env, checkinId);
    if (error) {
        return c.json({ error: error.message }, 500);
    }
    return c.json({ success: true });
}));
app.post('/feedback', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const body = yield c.req.json();
    const { score, feedback } = body;
    if (isNaN(score) || score < 1 || score > 5 || !feedback.trim()) {
        return c.json({ error: 'Invalid score or feedback' }, 400);
    }
    const { data, error } = yield (0, feedbackService_1.submitFeedback)(c.env, score, feedback);
    if (error) {
        return c.json({ error }, 500);
    }
    return c.json({ success: true, data });
}));
const ONE_HOUR_MS = 60 * 60 * 1000;
function runMetrixSync(env) {
    return __awaiter(this, void 0, void 0, function* () {
        const supabase = (0, supabase_1.getSupabaseClient)(env);
        const { data: competitions, error: fetchErr } = yield supabase
            .from('metrix_competition')
            .select('id, metrix_competition_id, status, last_synced_at')
            .neq('status', 'finished');
        if (fetchErr) {
            return { error: fetchErr.message, results: [] };
        }
        const now = Date.now();
        const results = [];
        for (const row of competitions !== null && competitions !== void 0 ? competitions : []) {
            const shouldSync = row.status === 'started' ||
                (row.status === 'waiting' && (row.last_synced_at == null ||
                    (now - new Date(row.last_synced_at).getTime() >= ONE_HOUR_MS)));
            if (!shouldSync)
                continue;
            try {
                const result = yield (0, metrixService_1.updateHoleStatsFromMetrix)(env, row.metrix_competition_id);
                if (result.success) {
                    yield supabase
                        .from('metrix_competition')
                        .update({ last_synced_at: new Date().toISOString() })
                        .eq('id', row.id);
                }
                results.push({ metrix_competition_id: row.metrix_competition_id, success: result.success });
                console.log('[Metrix] Stats updated for', row.metrix_competition_id, result);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                results.push({ metrix_competition_id: row.metrix_competition_id, success: false, error: message });
                console.error('[Metrix] Update failed for competition', row.metrix_competition_id, err);
            }
        }
        return { results };
    });
}
app.get('/debug/run-metrix', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const start = Date.now();
    const { error, results } = yield runMetrixSync(c.env);
    const duration = Date.now() - start;
    if (error) {
        console.error('[Metrix] Debug run: failed to load competitions', error);
        return c.json({ success: false, error, durationMs: duration }, 500);
    }
    return c.json({ success: true, results, durationMs: duration });
}));
exports.default = {
    fetch: app.fetch,
    scheduled: (event, env, ctx) => __awaiter(void 0, void 0, void 0, function* () {
        const start = Date.now();
        console.log("Scheduled task started at", new Date(event.scheduledTime).toISOString());
        const { error, results } = yield runMetrixSync(env);
        if (error) {
            console.error("Metrix scheduler: failed to load competitions", error);
            return;
        }
        const duration = Date.now() - start;
        console.log(`Scheduled task completed in ${duration}ms, synced ${results.length} competition(s)`);
    })
};
app.get('/holes/top-ranked', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const { data, error } = yield (0, ctpService_1.getTopRankedHoles)(c.env);
    if (error) {
        return c.json({ error }, 500);
    }
    return c.json(data);
}));
app.get('/holes', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const { data, error } = yield (0, ctpService_1.getHoles)(c.env);
    if (error) {
        return c.json({ error }, 500);
    }
    return c.json(data);
}));
// stats for selected player
app.get('/metrix/player/stats', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    const userId = String(user.metrixUserId);
    if (!userId)
        return c.json({ error: 'Invalid userId' }, 400);
    const metrixId = user.activeCompetitionId != null ? yield (0, playerService_1.getMetrixCompetitionId)(c.env, user.activeCompetitionId) : null;
    if (metrixId == null)
        return c.json({ error: 'No active competition' }, 400);
    const { data, error } = yield (0, metrixStatsService_1.getMetrixPlayerStats)(c.env, userId, metrixId);
    if (error)
        return c.json({ error }, 404);
    return c.json({ success: true, data });
}));
app.post('/auth/pre-login', (c) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const body = yield c.req.json();
    const email = ((_a = body.email) !== null && _a !== void 0 ? _a : '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
        return c.json({ success: false, error: 'Invalid email' }, 400);
    }
    // Check if player exists in DB
    const inDb = yield (0, playerService_1.checkPlayerExistsByEmail)(c.env, email);
    if (inDb) {
        return c.json({ success: true, data: { inDb: true } });
    }
    // Not in DB: fetch from Metrix and cache
    const identities = yield (0, metrixService_1.fetchMetrixIdentityByEmail)(email);
    yield (0, metrixService_1.cacheMetrixIdentities)(email, identities);
    return c.json({ success: true, data: { inDb: false, identities } });
}));
app.post('/auth/register-from-metrix', (c) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const body = yield c.req.json();
    const email = ((_a = body.email) !== null && _a !== void 0 ? _a : '').trim().toLowerCase();
    const metrixUserId = body.metrixUserId;
    if (!email || !email.includes('@')) {
        return c.json({ success: false, error: 'Invalid email' }, 400);
    }
    if (!metrixUserId || !Number.isFinite(metrixUserId)) {
        return c.json({ success: false, error: 'Invalid metrixUserId' }, 400);
    }
    // Try cache first
    let identities = yield (0, metrixService_1.getCachedMetrixIdentities)(email);
    // If cache miss, fetch from Metrix (fallback)
    if (!identities) {
        identities = yield (0, metrixService_1.fetchMetrixIdentityByEmail)(email);
        // Optionally write back to cache for retries
        yield (0, metrixService_1.cacheMetrixIdentities)(email, identities);
    }
    // Verify metrixUserId is in the list
    const chosen = identities.find((id) => id.userId === metrixUserId);
    if (!chosen) {
        return c.json({ success: false, error: 'Invalid email or Metrix user' }, 400);
    }
    // Upsert player
    const supabase = (0, supabase_1.getSupabaseClient)(c.env);
    const { error } = yield supabase
        .from('player')
        .upsert({
        email: email,
        metrix_user_id: chosen.userId,
        name: chosen.name,
    }, { onConflict: 'metrix_user_id' });
    if (error) {
        return c.json({ success: false, error: error.message }, 500);
    }
    return c.json({ success: true });
}));
app.post('/metrix/check-email', (c) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const body = yield c.req.json();
    const email = ((_a = body.email) !== null && _a !== void 0 ? _a : '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
        return c.json({ success: false, error: 'Invalid email' }, 400);
    }
    const identities = yield (0, metrixService_1.fetchMetrixIdentityByEmail)(email);
    const metrixUserId = identities.length === 1 ? identities[0].userId : null;
    return c.json({ success: true, data: { metrixUserId, identities } });
}));
app.get('/metrix/player/current-hole', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    const metrixId = user.activeCompetitionId != null ? yield (0, playerService_1.getMetrixCompetitionId)(c.env, user.activeCompetitionId) : null;
    if (metrixId == null)
        return c.json({ error: 'No active competition' }, 400);
    const { data, error } = yield (0, metrixService_1.getCurrentHole)(c.env, user.metrixUserId, metrixId);
    if (error)
        return c.json({ error }, 404);
    return c.json({ success: true, data: { currentHole: data } });
}));
//get user participations:
app.get('/player/participations', (c) => __awaiter(void 0, void 0, void 0, function* () {
    const user = c.get('user');
    const userMetrixId = user.metrixUserId;
    if (!userMetrixId)
        return c.json({ error: 'Invalid metrixUserId' }, 400);
    const participations = yield (0, playerService_1.getUserParticipation)(c.env, userMetrixId);
    return c.json({ success: true, data: participations }, 200, {
        "Cache-Control": "private, max-age=604800, stale-while-revalidate=86400",
    });
}));
app.get("/player/participations/leaders", (c) => __awaiter(void 0, void 0, void 0, function* () {
    const cache = yield caches.open("leaders-cache");
    // stable key, not tied to incoming headers
    const cacheKey = new Request("https://cache.local/leadersV1", { method: "GET" });
    const hit = yield cache.match(cacheKey);
    console.log("Cache lookup:", hit ? "HIT" : "MISS");
    if (hit)
        return hit;
    const leaderboard = yield (0, playerService_1.getParticipationLeaderboard)(c.env);
    const res = c.json({ success: true, data: leaderboard });
    // Make response cacheable + CORS that doesn't vary
    res.headers.set("Cache-Control", "public, max-age=86400, s-maxage=2592000");
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.headers.delete("Vary"); // important if your framework added Vary: Origin
    yield cache.put(cacheKey, res.clone());
    return res;
}));
