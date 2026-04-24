/**
 * Pace-of-play: derive per-pool "current hole" and blocking metrics from Metrix player rows.
 * Uses internal metrix_competition.id (stored as metrix_player_result.metrix_competition_id).
 */

export type PacePlayerRowInput = {
  start_group: number | null;
  total_holes: number;
  played_holes: number;
  last_played_hole_index: number | null;
  dnf: boolean;
  user_id: string;
  name: string | null;
};

export type PoolDerivedState = {
  poolNumber: number;
  totalHoles: number;
  startGroup: number;
  currentHole: number;
  playerCount: number;
  players: { user_id: string; name: string | null }[];
};

export type PaceSnapshotRow = {
  metrix_competition_id: number;
  pool_number: number;
  current_hole: number;
  holes_ahead_empty: number;
  pools_waiting_same_hole: number;
  pools_waiting_previous_hole: number;
  pools_waiting_total: number;
  player_count: number;
  updated_date: string;
};

/** Forward steps from start group S until pool is about to play hole H (same as currentHole = H). */
export function distStartToCurrentHole(
  S: number,
  H: number,
  N: number
): number {
  if (N <= 0) return 0;
  const s = ((S - 1 + N) % N) + 1;
  const h = ((H - 1 + N) % N) + 1;
  if (s <= h) return h - s;
  return N - s + h;
}

function clampStartGroup(start: number | null, N: number): number | null {
  if (start == null || !Number.isFinite(start)) return null;
  if (N <= 0) return null;
  if (start < 1 || start > N) return null;
  return start;
}

/** Next hole to play for one player; null = finished or unusable row. */
export function currentHoleForPlayer(p: PacePlayerRowInput): number | null {
  const N = p.total_holes;
  if (N <= 0) return null;
  if (p.played_holes >= N) return null;

  const S = clampStartGroup(p.start_group, N);
  if (S == null) return null;

  if (p.last_played_hole_index == null) {
    return S;
  }

  const lastIdx = p.last_played_hole_index;
  const lastCompleted = lastIdx + 1;
  if (lastCompleted >= N) {
    return 1;
  }
  return lastCompleted + 1;
}

function pickFurthestPlayer(rows: PacePlayerRowInput[]): PacePlayerRowInput {
  return rows.reduce((best, r) => {
    const br = (best.played_holes ?? 0) - (r.played_holes ?? 0);
    if (br !== 0) return br > 0 ? best : r;
    const bi = best.last_played_hole_index ?? -1;
    const ri = r.last_played_hole_index ?? -1;
    return ri > bi ? r : best;
  });
}

/** Group by start_group (pool). Skips null/invalid start or unusable totals. */
export function derivePoolStates(rows: PacePlayerRowInput[]): PoolDerivedState[] {
  const byPool = new Map<number, PacePlayerRowInput[]>();
  for (const r of rows) {
    const sg = r.start_group;
    if (sg == null || !Number.isFinite(sg)) continue;
    if (!byPool.has(sg)) byPool.set(sg, []);
    byPool.get(sg)!.push(r);
  }

  const pools: PoolDerivedState[] = [];
  for (const [poolNumber, group] of byPool) {
    const furthest = pickFurthestPlayer(group);
    const N = furthest.total_holes;
    if (N <= 0) continue;

    const startGroup = clampStartGroup(poolNumber, N);
    if (startGroup == null) continue;

    const currentHole = currentHoleForPlayer(furthest);
    if (currentHole == null) continue;

    const players = group.map((g) => ({
      user_id: g.user_id,
      name: g.name,
    }));

    pools.push({
      poolNumber,
      totalHoles: N,
      startGroup,
      currentHole,
      playerCount: group.length,
      players,
    });
  }

  return pools;
}

function previousHole(h: number, N: number): number {
  if (N <= 0) return h;
  return h === 1 ? N : h - 1;
}

function holeOccupied(
  hole: number,
  poolsByCurrent: Map<number, PoolDerivedState[]>
): boolean {
  const list = poolsByCurrent.get(hole);
  return (list?.length ?? 0) > 0;
}

/** Consecutive empty holes ahead, max 3 (stop at first occupied). */
export function countEmptyHolesAhead(
  currentHole: number,
  N: number,
  poolsByCurrent: Map<number, PoolDerivedState[]>
): number {
  if (N <= 0) return 0;
  let count = 0;
  for (let step = 1; step <= 3; step++) {
    // Next holes in play order after currentHole (1-based, wrap at N): 15→16,… not 15 again.
    const h = ((currentHole - 1 + step) % N) + 1;
    if (holeOccupied(h, poolsByCurrent)) break;
    count++;
  }
  return count;
}

export function computePaceSnapshotRows(
  metrixCompetitionId: number,
  pools: PoolDerivedState[],
  updatedDate: string
): PaceSnapshotRow[] {
  if (pools.length === 0) return [];

  const N = Math.max(0, ...pools.map((p) => p.totalHoles));
  if (N <= 0) return [];

  const poolsByCurrent = new Map<number, PoolDerivedState[]>();
  for (const p of pools) {
    const h = p.currentHole;
    if (!poolsByCurrent.has(h)) poolsByCurrent.set(h, []);
    poolsByCurrent.get(h)!.push(p);
  }

  const rows: PaceSnapshotRow[] = [];

  for (const B of pools) {
    const Hb = B.currentHole;
    const distB = distStartToCurrentHole(B.startGroup, Hb, N);

    const sameHoleList = poolsByCurrent.get(Hb) ?? [];
    let sameWaiting = 0;
    for (const P of sameHoleList) {
      if (P.poolNumber === B.poolNumber) continue;
      const distP = distStartToCurrentHole(P.startGroup, Hb, N);
      if (distP > distB) sameWaiting++;
    }

    const prev = previousHole(Hb, N);
    const prevList = poolsByCurrent.get(prev) ?? [];
    const prevCount = prevList.length;

    const poolsBehind = sameWaiting + prevCount;

    const holesAheadEmpty = countEmptyHolesAhead(Hb, N, poolsByCurrent);

    rows.push({
      metrix_competition_id: metrixCompetitionId,
      pool_number: B.poolNumber,
      current_hole: Hb,
      holes_ahead_empty: holesAheadEmpty,
      pools_waiting_same_hole: sameWaiting,
      pools_waiting_previous_hole: prevCount,
      pools_waiting_total: poolsBehind,
      player_count: B.playerCount,
      updated_date: updatedDate,
    });
  }

  return rows;
}

/** Top slow pools: both metrics > 0, sort by empty ahead desc then pools behind desc. */
export function rankSlowPools(rows: PaceSnapshotRow[], limit: number): PaceSnapshotRow[] {
  const filtered = rows.filter(
    (r) => r.holes_ahead_empty > 0 && r.pools_waiting_total > 0
  );
  filtered.sort((a, b) => {
    if (b.holes_ahead_empty !== a.holes_ahead_empty) {
      return b.holes_ahead_empty - a.holes_ahead_empty;
    }
    return b.pools_waiting_total - a.pools_waiting_total;
  });
  return filtered.slice(0, limit);
}

/** Cold-start self-checks for wrap / same-hole rules (throws if broken). */
export function runPaceOfPlaySelfChecks(): void {
  const N = 100;
  if (distStartToCurrentHole(29, 15, N) !== 86) {
    throw new Error("pace self-check: dist 29->15");
  }
  if (distStartToCurrentHole(25, 15, N) !== 90) {
    throw new Error("pace self-check: dist 25->15");
  }
  if (distStartToCurrentHole(26, 15, N) !== 89) {
    throw new Error("pace self-check: dist 26->15");
  }
  if (distStartToCurrentHole(1, 10, N) !== 9) {
    throw new Error("pace self-check: dist 1->10");
  }
  if (distStartToCurrentHole(99, 10, N) !== 11) {
    throw new Error("pace self-check: dist 99->10");
  }
  if (distStartToCurrentHole(100, 10, N) !== 10) {
    throw new Error("pace self-check: dist 100->10");
  }

  const pools: PoolDerivedState[] = [
    {
      poolNumber: 25,
      totalHoles: N,
      startGroup: 25,
      currentHole: 15,
      playerCount: 1,
      players: [],
    },
    {
      poolNumber: 26,
      totalHoles: N,
      startGroup: 26,
      currentHole: 15,
      playerCount: 1,
      players: [],
    },
    {
      poolNumber: 29,
      totalHoles: N,
      startGroup: 29,
      currentHole: 15,
      playerCount: 1,
      players: [],
    },
  ];
  const by = new Map<number, PoolDerivedState[]>();
  for (const p of pools) {
    const h = p.currentHole;
    if (!by.has(h)) by.set(h, []);
    by.get(h)!.push(p);
  }
  const d29 = distStartToCurrentHole(29, 15, N);
  const d25 = distStartToCurrentHole(25, 15, N);
  if (!(d29 < d25)) {
    throw new Error("pace self-check: active pool should be 29 at hole 15");
  }

  const empty = countEmptyHolesAhead(15, N, by);
  if (empty !== 3) {
    throw new Error(`pace self-check: empty ahead expected 3 got ${empty}`);
  }
}

runPaceOfPlaySelfChecks();
