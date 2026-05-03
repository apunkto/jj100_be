import type {Context} from 'hono'
import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {updateHoleStatsFromMetrix} from '../metrix/service'
import {rankSlowPools} from '../metrix/paceOfPlay'
import {getSupabaseClient} from '../shared/supabase'
import {requireAdmin} from '../middleware/admin'
import {runPredictionPrecompute} from '../prediction/precompute'
import {adminDidRainSchema, adminEnabledSchema, adminStatusSchema, parseJsonBody} from '../shared/validation'
import ledScreenRoutes from './ledScreenRoutes'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

router.route('/led-screen', ledScreenRoutes)

const ONE_HOUR_MS = 60 * 60 * 1000;

type MetrixSyncResult = { metrix_competition_id: number; success: boolean; error?: string };

export async function runMetrixSync(env: Env): Promise<{ error?: string; results: MetrixSyncResult[] }> {
    const supabase = getSupabaseClient(env);
    const { data: competitions, error: fetchErr } = await supabase
        .from('metrix_competition')
        .select('id, metrix_competition_id, status, last_synced_at')
        .neq('status', 'finished');

    if (fetchErr) {
        return { error: fetchErr.message, results: [] };
    }

    const now = Date.now();
    const results: MetrixSyncResult[] = [];

    for (const row of competitions ?? []) {
        const shouldSync =
            row.status === 'started' ||
            (row.status === 'waiting' && (
                row.last_synced_at == null ||
                (now - new Date(row.last_synced_at).getTime() >= ONE_HOUR_MS)
            ));
        if (!shouldSync) continue;

        try {
            const result = await updateHoleStatsFromMetrix(env, row.metrix_competition_id);
            if (result.success) {
                await supabase
                    .from('metrix_competition')
                    .update({ last_synced_at: new Date().toISOString() })
                    .eq('id', row.id);
            }
            results.push({ metrix_competition_id: row.metrix_competition_id, success: result.success });
            console.log('[Metrix] Stats updated for', row.metrix_competition_id, result);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            results.push({ metrix_competition_id: row.metrix_competition_id, success: false, error: message });
            console.error('[Metrix] Update failed for competition', row.metrix_competition_id, err);
        }
    }

    return { results };
}

router.get('/run-metrix', async (c) => {
    const start = Date.now();
    const { error, results } = await runMetrixSync(c.env);
    const duration = Date.now() - start;
    if (error) {
        console.error('[Metrix] Debug run: failed to load competitions', error);
        return c.json({ success: false, error, durationMs: duration }, 500);
    }
    return c.json({ success: true, results, durationMs: duration });
});

router.get('/run-prediction-precompute', async (c) => {
    const start = Date.now();
    const { error, results } = await runPredictionPrecompute(c.env);
    const duration = Date.now() - start;
    if (error) {
        console.error('[Prediction] Debug run: failed to load competitions', error);
        return c.json({ success: false, error, durationMs: duration }, 500);
    }
    return c.json({ success: true, results, durationMs: duration });
});

// Admin-only routes for competition management
router.use('/competitions', requireAdmin)
router.get('/competitions', async (c) => {
    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .select('id, name, competition_date, status, ctp_enabled, checkin_enabled, prediction_enabled, did_rain, food_choice_enabled')
        .order('competition_date', { ascending: true, nullsFirst: false })

    if (error) {
        return c.json({ success: false, error: error.message }, 500)
    }

    return c.json({ success: true, data: data ?? [] })
})

async function patchCompetitionFlag(
    c: Context<{ Bindings: Env; Variables: HonoVars }>,
    field: 'ctp_enabled' | 'checkin_enabled' | 'prediction_enabled' | 'did_rain' | 'food_choice_enabled'
) {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const parsed = await parseJsonBody(() => c.req.json(), adminEnabledSchema)
    if (!parsed.success) return c.json({ success: false, error: parsed.error }, 400)

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .update({ [field]: parsed.data.enabled })
        .eq('id', competitionId)
        .select(`id, ${field}`)
        .maybeSingle()

    if (error) return c.json({ success: false, error: error.message }, 500)
    if (!data) return c.json({ success: false, error: 'Competition not found' }, 404)

    return c.json({ success: true, data })
}

router.use('/competition/:id', requireAdmin)

/** Force Metrix sync for one competition (internal metrix_competition.id). Requires admin. */
router.get('/competition/:id/run-metrix', async (c) => {
    const competitionId = Number(c.req.param('id'));
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400);
    }

    const start = Date.now();
    const supabase = getSupabaseClient(c.env);
    const { data: row, error: fetchErr } = await supabase
        .from('metrix_competition')
        .select('id, metrix_competition_id')
        .eq('id', competitionId)
        .maybeSingle();

    const duration = () => Date.now() - start;

    if (fetchErr) {
        console.error('[Metrix] Single sync: failed to load competition', fetchErr);
        return c.json({ success: false, error: fetchErr.message, durationMs: duration() }, 500);
    }
    if (!row) {
        return c.json({ success: false, error: 'Competition not found', durationMs: duration() }, 404);
    }

    try {
        const syncResult = await updateHoleStatsFromMetrix(c.env, row.metrix_competition_id);
        if (syncResult.success) {
            await supabase
                .from('metrix_competition')
                .update({ last_synced_at: new Date().toISOString() })
                .eq('id', row.id);
        }
        const result: MetrixSyncResult = {
            metrix_competition_id: row.metrix_competition_id,
            success: syncResult.success,
            ...(!syncResult.success && syncResult.error
                ? { error: syncResult.error instanceof Error ? syncResult.error.message : String(syncResult.error) }
                : {}),
        };
        console.log('[Metrix] Single sync:', row.metrix_competition_id, syncResult.success);
        return c.json({ success: true, result, durationMs: duration() });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[Metrix] Single sync failed:', row.metrix_competition_id, err);
        const failResult: MetrixSyncResult = {
            metrix_competition_id: row.metrix_competition_id,
            success: false,
            error: message,
        };
        return c.json({ success: true, result: failResult, durationMs: duration() });
    }
});

router.patch('/competition/:id/ctp', (c) => patchCompetitionFlag(c, 'ctp_enabled'))
router.patch('/competition/:id/checkin', (c) => patchCompetitionFlag(c, 'checkin_enabled'))
router.patch('/competition/:id/prediction', (c) => patchCompetitionFlag(c, 'prediction_enabled'))
router.patch('/competition/:id/food-choice', (c) => patchCompetitionFlag(c, 'food_choice_enabled'))
router.patch('/competition/:id/did-rain', async (c) => {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const parsed = await parseJsonBody(() => c.req.json(), adminDidRainSchema)
    if (!parsed.success) return c.json({ success: false, error: parsed.error }, 400)

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .update({ did_rain: parsed.data.did_rain })
        .eq('id', competitionId)
        .select('id, did_rain')
        .maybeSingle()

    if (error) return c.json({ success: false, error: error.message }, 500)
    if (!data) return c.json({ success: false, error: 'Competition not found' }, 404)

    return c.json({ success: true, data })
})

router.patch('/competition/:id/status', async (c) => {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const parsed = await parseJsonBody(() => c.req.json(), adminStatusSchema)
    if (!parsed.success) return c.json({ success: false, error: parsed.error }, 400)
    const status = parsed.data.status

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .update({ status })
        .eq('id', competitionId)
        .select('id, status')
        .maybeSingle()

    if (error) {
        return c.json({ success: false, error: error.message }, 500)
    }

    if (!data) {
        return c.json({ success: false, error: 'Competition not found' }, 404)
    }

    return c.json({ success: true, data })
})

router.get('/competition/:id/pace-of-play', async (c) => {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_pace_of_play_pool')
        .select(
            'pool_number, current_hole, holes_ahead_empty, pools_waiting_same_hole, pools_waiting_previous_hole, pools_waiting_total, player_count, updated_date'
        )
        .eq('metrix_competition_id', competitionId)

    if (error) {
        return c.json({ success: false, error: error.message }, 500)
    }

    const rows = (data ?? []) as Parameters<typeof rankSlowPools>[0]
    const top = rankSlowPools(rows, 10)

    return c.json({ success: true, data: top })
})

router.get('/competition/:id/pace-of-play/pool/:poolNumber', async (c) => {
    const competitionId = Number(c.req.param('id'))
    const poolNumber = Number(c.req.param('poolNumber'))
    if (!Number.isFinite(competitionId) || !Number.isFinite(poolNumber)) {
        return c.json({ success: false, error: 'Invalid competition or pool' }, 400)
    }

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_player_result')
        .select('user_id, name')
        .eq('metrix_competition_id', competitionId)
        .eq('start_group', poolNumber)
        .order('name', { ascending: true, nullsFirst: false })

    if (error) {
        return c.json({ success: false, error: error.message }, 500)
    }

    return c.json({ success: true, data: data ?? [] })
})

export default router
