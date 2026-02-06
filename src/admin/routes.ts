import {Hono} from 'hono'
import type {Env} from '../shared/types'
import type {PlayerIdentity} from '../player/types'
import {updateHoleStatsFromMetrix} from '../metrix/service'
import {getSupabaseClient} from '../shared/supabase'
import {requireAdmin} from '../middleware/admin'

type HonoVars = { user: PlayerIdentity }
const router = new Hono<{ Bindings: Env; Variables: HonoVars }>()

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

// Admin-only routes for competition management
router.use('/competitions', requireAdmin)
router.get('/competitions', async (c) => {
    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .select('id, name, competition_date, status, ctp_enabled, checkin_enabled, prediction_enabled')
        .order('competition_date', { ascending: true, nullsFirst: false })

    if (error) {
        return c.json({ success: false, error: error.message }, 500)
    }

    return c.json({ success: true, data: data ?? [] })
})

router.use('/competition/:id', requireAdmin)
router.patch('/competition/:id/ctp', async (c) => {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const body = await c.req.json().catch(() => ({}))
    if (typeof body.enabled !== 'boolean') {
        return c.json({ success: false, error: 'Missing or invalid enabled field' }, 400)
    }

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .update({ ctp_enabled: body.enabled })
        .eq('id', competitionId)
        .select('id, ctp_enabled')
        .maybeSingle()

    if (error) {
        return c.json({ success: false, error: error.message }, 500)
    }

    if (!data) {
        return c.json({ success: false, error: 'Competition not found' }, 404)
    }

    return c.json({ success: true, data })
})

router.patch('/competition/:id/checkin', async (c) => {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const body = await c.req.json().catch(() => ({}))
    if (typeof body.enabled !== 'boolean') {
        return c.json({ success: false, error: 'Missing or invalid enabled field' }, 400)
    }

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .update({ checkin_enabled: body.enabled })
        .eq('id', competitionId)
        .select('id, checkin_enabled')
        .maybeSingle()

    if (error) {
        return c.json({ success: false, error: error.message }, 500)
    }

    if (!data) {
        return c.json({ success: false, error: 'Competition not found' }, 404)
    }

    return c.json({ success: true, data })
})

router.patch('/competition/:id/prediction', async (c) => {
    const competitionId = Number(c.req.param('id'))
    if (!Number.isFinite(competitionId)) {
        return c.json({ success: false, error: 'Invalid competition ID' }, 400)
    }

    const body = await c.req.json().catch(() => ({}))
    if (typeof body.enabled !== 'boolean') {
        return c.json({ success: false, error: 'Missing or invalid enabled field' }, 400)
    }

    const supabase = getSupabaseClient(c.env)
    const { data, error } = await supabase
        .from('metrix_competition')
        .update({ prediction_enabled: body.enabled })
        .eq('id', competitionId)
        .select('id, prediction_enabled')
        .maybeSingle()

    if (error) {
        return c.json({ success: false, error: error.message }, 500)
    }

    if (!data) {
        return c.json({ success: false, error: 'Competition not found' }, 404)
    }

    return c.json({ success: true, data })
})

export default router
