import {getSupabaseClient} from "../shared/supabase";
import type {Env} from "../shared/types";
import {getPlayerResult} from "./statsService";
import {computePaceSnapshotRows, derivePoolStates, type PacePlayerRowInput,} from "./paceOfPlay";

type SupabaseServiceClient = ReturnType<typeof getSupabaseClient>;

/** Metrix "Waiting List" pseudo-division — exclude from JJ100 cache. */
function isMetrixWaitingListClass(className: string | null | undefined): boolean {
  return String(className ?? "").trim().toLowerCase() === "waiting list";
}

async function deleteMetrixPlayerResultRowIds(
  supabase: SupabaseServiceClient,
  resultIds: number[]
): Promise<void> {
  if (resultIds.length === 0) return;
  const { error: ctpDelErr } = await supabase
    .from("ctp_results")
    .delete()
    .in("metrix_player_result_id", resultIds);
  if (ctpDelErr) {
    console.error(
      "[Metrix] ctp_results delete before metrix_player_result removal failed:",
      ctpDelErr
    );
    return;
  }
  const { error: delErr } = await supabase
    .from("metrix_player_result")
    .delete()
    .in("id", resultIds);
  if (delErr) {
    console.error("[Metrix] metrix_player_result row delete failed:", delErr);
  }
}

async function persistMetrixPaceOfPlaySnapshot(
  supabase: SupabaseServiceClient,
  competitionId: number,
  playerRows: PacePlayerRowInput[],
  updatedDate: string
): Promise<void> {
  const poolStates = derivePoolStates(playerRows);
  const activePoolNums = new Set(poolStates.map((p) => p.poolNumber));

  const { data: existingRows, error: listErr } = await supabase
    .from("metrix_pace_of_play_pool")
    .select("pool_number")
    .eq("metrix_competition_id", competitionId);

  if (listErr) {
    console.error(
      "[Metrix] metrix_pace_of_play_pool list for cleanup failed:",
      listErr
    );
  }

  if (activePoolNums.size === 0) {
    if ((existingRows?.length ?? 0) > 0) {
      const { error: delAllErr } = await supabase
        .from("metrix_pace_of_play_pool")
        .delete()
        .eq("metrix_competition_id", competitionId);
      if (delAllErr) {
        console.error(
          "[Metrix] metrix_pace_of_play_pool delete all failed:",
          delAllErr
        );
      }
    }
    return;
  }

  const snapshotRows = computePaceSnapshotRows(
    competitionId,
    poolStates,
    updatedDate
  );

  if (snapshotRows.length > 0) {
    const { error: upErr } = await supabase
      .from("metrix_pace_of_play_pool")
      .upsert(snapshotRows, {
        onConflict: "metrix_competition_id,pool_number",
      });
    if (upErr) {
      console.error("[Metrix] metrix_pace_of_play_pool upsert failed:", upErr);
    }
  }

  const existingNums = new Set(
    (existingRows ?? []).map((r: { pool_number: number }) => r.pool_number)
  );
  const toDelete = [...existingNums].filter((n) => !activePoolNums.has(n));
  if (toDelete.length > 0) {
    const { error: delErr } = await supabase
      .from("metrix_pace_of_play_pool")
      .delete()
      .eq("metrix_competition_id", competitionId)
      .in("pool_number", toDelete);
    if (delErr) {
      console.error("[Metrix] metrix_pace_of_play_pool delete failed:", delErr);
    }
  }
}

const METRIX_ALPS_API_BASE = "https://alps.discgolfmetrix.com/api";

/** Alps `user.show` — https://alps.discgolfmetrix.com/docs/api#/operations/user.show */
interface AlpsUserResource {
  id: number;
  email: string;
  name: string;
  rating: number | null;
}

interface AlpsUserShowResponse {
  data: AlpsUserResource[];
}

// Types for Metrix API Response
export interface HoleResult {
  Result: string;
  Diff: number;
  PEN: string;
}

export interface PlayerResult {
  UserID: string;
  Name: string;
  OrderNumber: number;
  Diff: number;
  ClassName: string;
  Sum: number;
  Dnf?: boolean | null;
  PlayerResults?: HoleResult[];
  Group: string;
}

export interface CompetitionElement {
  Name?: string;
  Date?: string; // e.g. "2026-02-07"
  Results: PlayerResult[];
}

export type MetrixIdentity = {
  userId: number;
  name: string;
};

const METRIX_IDENTITIES_CACHE_NAME = "metrix-identities-cache";
const CACHE_TTL_SECONDS = 120; // 2 minutes

function getCacheKeyForEmail(email: string): Request {
  const normalizedEmail = email.trim().toLowerCase();
  return new Request(
    `https://cache.local/metrix-identities/${encodeURIComponent(
      normalizedEmail
    )}`,
    { method: "GET" }
  );
}

export async function cacheMetrixIdentities(
  email: string,
  identities: MetrixIdentity[]
): Promise<void> {
  const cache = await caches.open(METRIX_IDENTITIES_CACHE_NAME);
  const cacheKey = getCacheKeyForEmail(email);
  const response = new Response(JSON.stringify(identities), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(cacheKey, response);
}

export async function getCachedMetrixIdentities(
  email: string
): Promise<MetrixIdentity[] | null> {
  const cache = await caches.open(METRIX_IDENTITIES_CACHE_NAME);
  const cacheKey = getCacheKeyForEmail(email);
  const cached = await cache.match(cacheKey);

  if (!cached) return null;

  try {
    return (await cached.json()) as MetrixIdentity[];
  } catch {
    return null;
  }
}

interface MetrixAPIResponse {
  Competition: CompetitionElement;
}

// Helpers for updateHoleStatsFromMetrix
/** Metrix scorecard holes (strokes/diff/penalty) — not CTP; used to avoid deleting rows that still hold round data. */
function hasScorecardHoleData(playerResults: unknown): boolean {
  if (!Array.isArray(playerResults)) return false;
  for (const el of playerResults) {
    if (el == null || typeof el !== "object") continue;
    const hole = el as HoleResult;
    const result = String(hole.Result ?? "").trim();
    if (result !== "") return true;
    if (typeof hole.Diff === "number" && Number.isFinite(hole.Diff)) return true;
    const pen = String(hole.PEN ?? "").trim();
    if (pen !== "" && pen !== "0") return true;
  }
  return false;
}

function hasOb(hole: HoleResult | undefined): boolean {
  if (hole == null) return false;
  const pen = String(hole.PEN ?? "").trim();
  return pen !== "" && pen !== "0";
}

function isHio(result: unknown): boolean {
  if (result == null) return false;
  const s = String(result).trim();
  return s === "1" || Number(s) === 1;
}

function parseGroup(group: string | undefined): number | null {
  const g = parseInt(String(group ?? ""), 10);
  return Number.isFinite(g) ? g : null;
}

interface HoleStatsEntry {
  eagles: number;
  birdies: number;
  pars: number;
  bogeys: number;
  double_bogeys: number;
  others: number;
  sumDiff: number;
  diffCount: number;
  hioCount: number;
  playersWithPen: Set<string>;
}

function createEmptyHoleStat(): HoleStatsEntry {
  return {
    eagles: 0,
    birdies: 0,
    pars: 0,
    bogeys: 0,
    double_bogeys: 0,
    others: 0,
    sumDiff: 0,
    diffCount: 0,
    hioCount: 0,
    playersWithPen: new Set<string>(),
  };
}

function getOrCreateHoleStat(
  holeStats: Record<number, HoleStatsEntry>,
  holeIndex: number
): HoleStatsEntry {
  if (!holeStats[holeIndex]) {
    holeStats[holeIndex] = createEmptyHoleStat();
  }
  return holeStats[holeIndex];
}

function accumulateHoleStat(
  holeStats: Record<number, HoleStatsEntry>,
  holeIndex: number,
  hole: HoleResult | undefined,
  userId: string,
  pen?: boolean
): void {
  const diff = hole?.Diff;
  const stat = getOrCreateHoleStat(holeStats, holeIndex);

  if (typeof diff === "number") {
    if (diff <= -2) stat.eagles++;
    else if (diff === -1) stat.birdies++;
    else if (diff === 0) stat.pars++;
    else if (diff === 1) stat.bogeys++;
    else if (diff === 2) stat.double_bogeys++;
    else if (diff >= 3) stat.others++;
    if (Number.isFinite(diff)) {
      stat.sumDiff += diff;
      stat.diffCount += 1;
    }
  }

  if (pen ?? hasOb(hole)) {
    stat.playersWithPen.add(userId);
  }

  if (isHio(hole?.Result)) {
    stat.hioCount += 1;
  }
}

export async function fetchMetrixIdentityByEmail(
  env: Env,
  email: string
): Promise<MetrixIdentity[]> {
  const code = env.METRIX_ALPS_INTEGRATION_CODE?.trim();
  if (!code) {
    console.warn("[Metrix Alps] METRIX_ALPS_INTEGRATION_CODE is not configured");
    return [];
  }

  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];

  const url = new URL(`${METRIX_ALPS_API_BASE}/user`);
  url.searchParams.set("email", normalized);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-Integration-Code": code,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      "[Metrix Alps] user.show failed:",
      res.status,
      res.statusText,
      detail.slice(0, 500)
    );
    return [];
  }

  let body: AlpsUserShowResponse;
  try {
    body = (await res.json()) as AlpsUserShowResponse;
  } catch {
    console.error("[Metrix Alps] user.show: invalid JSON");
    return [];
  }

  const items = body?.data;
  if (!Array.isArray(items)) return [];

  return items.map((u) => ({
    userId: u.id,
    name: u.name ?? "",
  }));
}

export const updateHoleStatsFromMetrix = async (
  env: Env,
  metrixCompetitionId: number
) => {
  const supabase = getSupabaseClient(env);
  const url =
    "https://discgolfmetrix.com/api.php?content=result&id=" +
    metrixCompetitionId;

  const fetchStart = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    console.error("[Metrix] Fetch failed:", res.status, res.statusText);
    return {
      success: false,
      updated: 0,
      error: new Error(`Metrix API returned ${res.status}`),
    };
  }
  const data = (await res.json()) as MetrixAPIResponse;
  const fetchDuration = Date.now() - fetchStart;
  console.log(`[Metrix] Fetch duration: ${fetchDuration}ms`);

  const comp = data?.Competition;
  if (!comp) {
    return { success: true, updated: 0, error: null };
  }

  const competitionName = comp.Name ?? null;
  const competitionDate = comp.Date ?? null;

  const { data: compRow } = await supabase
    .from("metrix_competition")
    .upsert(
      {
        metrix_competition_id: metrixCompetitionId,
        name: competitionName,
        competition_date: competitionDate,
      },
      { onConflict: "metrix_competition_id" }
    )
    .select("id")
    .single();

  const competitionId = compRow?.id ?? null;
  if (competitionId == null) {
    console.error(
      "[Metrix] Failed to resolve competition id for",
      metrixCompetitionId
    );
    return { success: false, updated: 0, error: null };
  }

  const players = (comp.Results || []).filter(
    (p) =>
      p.UserID != null &&
      p.UserID !== "" &&
      !isMetrixWaitingListClass(p.ClassName)
  );
  console.log("players size", players.length);

  const { data: waterHoles } = await supabase
    .from("hole")
    .select("number")
    .eq("metrix_competition_id", competitionId)
    .eq("is_water_hole", true);
  const waterHoleNumbers = new Set(waterHoles?.map((h) => h.number) ?? []);

  const holeStats: Record<number, HoleStatsEntry> = {};
  const now = new Date().toISOString();

  const playerRows = players.map((p) => {
    const holes = p.PlayerResults ?? [];
    const userId = String(p.UserID);
    let waterHolesWithPen = 0;
    let eagles = 0,
      birdies = 0,
      birdieOrBetter = 0,
      pars = 0,
      bogeys = 0,
      doubleBogeys = 0,
      tripleOrWorse = 0;
    let playedHoles = 0,
      obHoles = 0;
    let lastPlayedHoleIndex: number | null = null;

    for (let i = 0; i < holes.length; i++) {
      const holeNumber = i + 1;
      const hole = holes[i];
      const diff = hole?.Diff;
      const result = (hole?.Result ?? "").toString().trim();
      const pen = hasOb(hole);

      if (result !== "") {
        playedHoles++;
        lastPlayedHoleIndex = i;
      }
      if (pen) obHoles++;
      if (typeof diff === "number") {
        if (diff <= -2) eagles++;
        else if (diff === -1) birdies++;
        else if (diff === 0) pars++;
        else if (diff === 1) bogeys++;
        else if (diff === 2) doubleBogeys++;
        else if (diff >= 3) tripleOrWorse++;
        if (diff <= -1) birdieOrBetter++;
      }
      if (waterHoleNumbers.has(holeNumber) && pen) {
        waterHolesWithPen++;
      }

      accumulateHoleStat(holeStats, holeNumber, hole, userId, pen);
    }

    return {
      metrix_competition_id: competitionId,
      user_id: userId,
      name: p.Name ?? null,
      class_name: p.ClassName ?? null,
      order_number: null,
      diff: p.Diff ?? null,
      sum: p.Sum ?? null,
      dnf: Boolean(p.Dnf),
      start_group: parseGroup(p.Group),
      player_results: p.PlayerResults ?? null,
      water_holes_with_pen: waterHolesWithPen,
      birdie_or_better: birdieOrBetter,
      pars,
      bogeys,
      eagles,
      birdies,
      double_bogeys: doubleBogeys,
      triple_or_worse: tripleOrWorse,
      total_holes: holes.length,
      played_holes: playedHoles,
      ob_holes: obHoles,
      last_played_hole_index: lastPlayedHoleIndex,
      updated_date: now,
    };
  });

  // Compute order_number (rank within division) for non-DNF only; DNF stays null
  const byClass = new Map<string, typeof playerRows>();
  for (const row of playerRows) {
    const key = row.class_name ?? "";
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key)!.push(row);
  }
  for (const rows of byClass.values()) {
    const nonDnf = rows.filter((r) => !r.dnf);
    nonDnf.sort((a, b) => {
      const diffA = a.diff ?? Infinity;
      const diffB = b.diff ?? Infinity;
      if (diffA !== diffB) return diffA - diffB;
      if ((b.birdie_or_better ?? 0) !== (a.birdie_or_better ?? 0))
        return (b.birdie_or_better ?? 0) - (a.birdie_or_better ?? 0);
      if ((b.pars ?? 0) !== (a.pars ?? 0)) return (b.pars ?? 0) - (a.pars ?? 0);
      return (b.bogeys ?? 0) - (a.bogeys ?? 0);
    });
    nonDnf.forEach((row, index) => {
      (row as { order_number: number | null }).order_number = index + 1;
    });
  }

  let playerUpsertFailed = false;
  if (playerRows.length > 0) {
    const { error } = await supabase
      .from("metrix_player_result")
      .upsert(playerRows, { onConflict: "metrix_competition_id,user_id" });
    if (error) {
      playerUpsertFailed = true;
      console.error("[Metrix] metrix_player_result upsert failed:", error);
    }
  }

  // Remove DB rows for players no longer in Metrix results (upsert only adds/updates).
  if (!playerUpsertFailed) {
    const apiUserIds = new Set(players.map((p) => String(p.UserID)));
    const { data: existingPlayerRows, error: listErr } = await supabase
      .from("metrix_player_result")
      .select("id, user_id, player_results, played_holes, class_name")
      .eq("metrix_competition_id", competitionId);

    if (listErr) {
      console.error(
        "[Metrix] metrix_player_result list for stale cleanup failed:",
        listErr
      );
    } else {
      const waitingListIds = (existingPlayerRows ?? [])
        .filter((r: { class_name?: string | null }) =>
          isMetrixWaitingListClass(r.class_name)
        )
        .map((r: { id: number }) => r.id);

      const staleIds = (existingPlayerRows ?? [])
        .filter((r: { user_id: string }) => !apiUserIds.has(r.user_id))
        .filter((r: { player_results?: unknown; played_holes?: number | null }) => {
          if (hasScorecardHoleData(r.player_results)) return false;
          const played = r.played_holes ?? 0;
          if (typeof played === "number" && played > 0) return false;
          return true;
        })
        .map((r: { id: number }) => r.id);

      const toRemove = [...new Set([...waitingListIds, ...staleIds])];
      if (toRemove.length > 0) {
        await deleteMetrixPlayerResultRowIds(supabase, toRemove);
      }
    }
  }

  if (!playerUpsertFailed) {
    const paceInputs: PacePlayerRowInput[] = playerRows.map((r) => ({
      start_group: r.start_group ?? null,
      total_holes: r.total_holes ?? 0,
      played_holes: r.played_holes ?? 0,
      last_played_hole_index: r.last_played_hole_index ?? null,
      dnf: Boolean(r.dnf),
      user_id: String(r.user_id),
      name: r.name ?? null,
    }));
    await persistMetrixPaceOfPlaySnapshot(
      supabase,
      competitionId,
      paceInputs,
      now
    );
  }

  const entries = Object.entries(holeStats);
  if (entries.length === 0) {
    return { success: true, updated: 0, error: null };
  }

  const holeNumbers = entries.map(([numStr]) => Number(numStr));

  const holeNumbersByAvgDiff = entries.map(([numStr, stats]) => {
    const num = Number(numStr);
    const average_diff =
      stats.diffCount > 0 ? stats.sumDiff / stats.diffCount : 0;
    return { number: num, average_diff };
  });
  holeNumbersByAvgDiff.sort((a, b) => b.average_diff - a.average_diff);
  const rankByHoleNumber: Record<number, number> = {};
  holeNumbersByAvgDiff.forEach((entry, index) => {
    rankByHoleNumber[entry.number] = index + 1;
  });

  const { data: existingHoles } = await supabase
    .from("hole")
    .select("number")
    .eq("metrix_competition_id", competitionId)
    .in("number", holeNumbers);
  const existingNumbers = new Set((existingHoles ?? []).map((h) => h.number));

  const updates = entries.map(([holeNumber, stats]) => {
    const num = Number(holeNumber);
    const average_diff =
      stats.diffCount > 0 ? stats.sumDiff / stats.diffCount : 0;
    const playersWithPenCount = stats.playersWithPen.size;
    const ob_percent =
      stats.diffCount > 0 ? (playersWithPenCount / stats.diffCount) * 100 : 0;
    const row: Record<string, unknown> = {
      metrix_competition_id: competitionId,
      number: num,
      eagles: stats.eagles,
      birdies: stats.birdies,
      pars: stats.pars,
      bogeys: stats.bogeys,
      double_bogeys: stats.double_bogeys,
      others: stats.others,
      average_diff,
      rank: rankByHoleNumber[num] ?? 0,
      ob_percent,
      hio_count: stats.hioCount,
      players_with_pen: playersWithPenCount,
    };
    if (!existingNumbers.has(num)) {
      row.card_img = "no_image";
    }
    return row;
  });

  const { error } = await supabase
    .from("hole")
    .upsert(updates, { onConflict: "metrix_competition_id,number" });

  return { success: !error, updated: updates.length, error };
};

export const getCurrentHole = async (
  env: Env,
  userId: number,
  competitionId: number
) => {
  const { data: row, error } = await getPlayerResult(
    env,
    competitionId,
    String(userId)
  );
  if (error) return { data: null, error };
  if (!row) return { data: 1, error: null };

  const totalHoles = row.total_holes ?? 0;
  const group = row.start_group;
  const groupHole =
    group != null && Number.isFinite(group) && group > 0 ? group : 1;

  if (totalHoles <= 0) {
    return { data: groupHole, error: null };
  }
  

  const lastIdx = row.last_played_hole_index;
  if (lastIdx == null) {
    return { data: groupHole, error: null };
  }

  if (lastIdx + 1 >= totalHoles) {
    return { data: 1, error: null };
  }

  return { data: lastIdx + 2, error: null };
};

function hasPenalty(hole: HoleResult | undefined): boolean {
  if (hole == null) return false;
  const pen = String(hole.PEN ?? "").trim();
  return pen !== "" && pen !== "0";
}

/**
 * Get the user's result (throws) and penalty flag on a specific hole.
 */
export const getUserResultOnHole = async (
  env: Env,
  competitionId: number,
  userId: string,
  holeNumber: number
): Promise<{
  data: { result: string | null; hasPenalty: boolean };
  error: { message: string } | null;
}> => {
  const holeIndex = holeNumber - 1;
  if (!Number.isInteger(holeNumber) || holeNumber < 1 || holeIndex < 0) {
    return {
      data: { result: null, hasPenalty: false },
      error: { message: "Invalid hole number" },
    };
  }

  const supabase = getSupabaseClient(env);
  const { data, error } = await supabase
    .from("metrix_player_result")
    .select("player_results")
    .eq("metrix_competition_id", competitionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { data: { result: null, hasPenalty: false }, error };
  const arr = (data as { player_results: HoleResult[] | null } | null)
    ?.player_results;
  const el =
    Array.isArray(arr) && holeIndex < arr.length ? arr[holeIndex] : undefined;
  const result = el?.Result != null ? String(el.Result) : null;
  const hasPen = hasPenalty(el);
  return { data: { result, hasPenalty: hasPen }, error: null };
};
