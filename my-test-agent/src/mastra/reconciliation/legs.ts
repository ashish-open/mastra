/**
 * Multi-leg reconciliation runner.
 *
 * Wraps the per-leg primitive (`runMatchesOnPool` from matcher.ts) into an
 * orchestrator that walks `ReconcileConfig.legs[]` in order, piping matched /
 * unmatched rows between legs via the configured `outputs.asSource` synthetic
 * source name. Tags every emitted decision with `metadata.legId` so the audit
 * trail records which leg produced the match.
 *
 * Design notes (from the plan):
 *   - LEGS ARE ORDERED. Leg N consumes pools that may include carried-forward
 *     rows from Leg N-1 (via `outputs.asSource`).
 *   - The pools map is SHARED across legs. A leg's match strategy refers to
 *     adapter ids (initial fetch) OR synthetic source names (from prior legs'
 *     outputs).
 *   - We never load rows twice — the carried-forward synthetic source is a
 *     reference to the same NormalizedTxn objects, not a clone.
 *   - candidatePool (for fuzzy stage, if enabled) = union of ALL initial txns,
 *     i.e. unchanged from the single-leg path.
 *
 * Backwards-compat: configs without `legs[]` go through the legacy
 * `runMatchGraph` path. The workflow.ts step picks one based on presence.
 */

import type { ReconcileConfig, ReconcileLeg } from './adapter.js';
import type { NormalizedTxn, RecoDecision } from './types.js';
import { runMatchesOnPool, type DeterministicMatchOutput } from './matcher.js';

interface FetchedSource {
  adapterId: string;
  txns: NormalizedTxn[];
}

/**
 * Run every leg in `config.legs[]` and return the same shape as
 * `runMatchGraph()`. The caller (workflow) doesn't need to know the difference.
 *
 * Throws if `config.legs` is undefined or empty — callers must check first.
 */
export function runLegs(
  config: ReconcileConfig,
  fetched: FetchedSource[],
): DeterministicMatchOutput {
  if (!config.legs || config.legs.length === 0) {
    throw new Error(
      `runLegs called on config '${config.id}' but config.legs is empty. ` +
      `Use runMatchGraph() for legacy single-leg configs.`,
    );
  }

  // Initial pools: one entry per adapter, holding all its fetched rows.
  // We also snapshot every row keyed by sourceId so we can resurrect matched
  // rows when carrying forward (the matcher consumes rows out of the pool
  // when they match; we need to put them BACK under a synthetic name).
  const pools = new Map<string, NormalizedTxn[]>();
  const candidatePool: NormalizedTxn[] = [];
  const sourceIdIndex = new Map<string, NormalizedTxn>();
  for (const f of fetched) {
    pools.set(f.adapterId, [...f.txns]);
    candidatePool.push(...f.txns);
    for (const t of f.txns) sourceIdIndex.set(t.sourceId, t);
  }

  const decisions: RecoDecision[] = [];

  for (const leg of config.legs) {
    // Validate `leg.inputs[]` — strategies should reference declared inputs or
    // a prior leg's `outputs.asSource`. We don't enforce this strictly, but
    // we log a warning when a strategy references something not yet in pools.
    for (const strategy of leg.matches) {
      if (!pools.has(strategy.from)) {
        console.warn(
          `[reco-legs] leg '${leg.id}': strategy '${strategy.name}' references from='${strategy.from}' ` +
          `which is not in pools yet. Available: [${Array.from(pools.keys()).join(', ')}].`,
        );
      }
      if (!pools.has(strategy.to)) {
        console.warn(
          `[reco-legs] leg '${leg.id}': strategy '${strategy.name}' references to='${strategy.to}' ` +
          `which is not in pools yet. Available: [${Array.from(pools.keys()).join(', ')}].`,
        );
      }
    }

    // Run all match strategies in this leg. runMatchesOnPool consumes matched
    // rows out of `pools` and tags every decision with metadata.legId = leg.id.
    const legT0 = process.hrtime.bigint();
    const poolSizesIn = leg.matches.map(s =>
      `${s.from}=${(pools.get(s.from) ?? []).length}/${s.to}=${(pools.get(s.to) ?? []).length}`,
    ).join(' ');
    console.log(`[reco-legs] leg '${leg.id}' starting — pools: ${poolSizesIn}`);

    const legDecisions = runMatchesOnPool(leg.matches, pools, leg.id);
    decisions.push(...legDecisions);

    const legMs = Number(process.hrtime.bigint() - legT0) / 1_000_000;
    console.log(
      `[reco-legs] leg '${leg.id}' (${leg.name}) done in ${legMs.toFixed(0)}ms: ` +
      `${legDecisions.length} decisions emitted`,
    );

    // Promote rows for the next leg, if this leg declares outputs.
    if (leg.outputs) {
      const carryT0 = process.hrtime.bigint();
      const carried = computeCarryForward(leg, legDecisions, sourceIdIndex, pools);
      pools.set(leg.outputs.asSource, carried);
      const carryMs = Number(process.hrtime.bigint() - carryT0) / 1_000_000;
      console.log(
        `[reco-legs] leg '${leg.id}' → carry-forward '${leg.outputs.asSource}': ` +
        `${carried.length} rows (${leg.outputs.carryForward}) in ${carryMs.toFixed(0)}ms`,
      );
    }
  }

  // Final residual: rows still sitting in pools that no leg matched.
  // We exclude synthetic carry-forward sources from this — they're already
  // accounted for via their leg's decisions (matched) or pass-through to next leg.
  const carriedNames = new Set<string>();
  for (const leg of config.legs) {
    if (leg.outputs?.asSource) carriedNames.add(leg.outputs.asSource);
  }
  const initialAdapterIds = new Set(fetched.map(f => f.adapterId));

  const unmatched: NormalizedTxn[] = [];
  for (const [poolName, txns] of pools) {
    // Only count rows from initial adapters as unmatched residual.
    // Synthetic carry-forward pools are "pass-through" — their rows either
    // became matched-by-next-leg (consumed) or are residual under the original
    // adapter id (the matcher leaves them there).
    //
    // Subtlety: when a leg's `outputs.carryForward === 'matched'`, the matched
    // rows are placed into the synthetic pool. If a downstream leg doesn't
    // consume them, they appear in BOTH the synthetic pool AND we shouldn't
    // double-count. We handle this by considering only initial-adapter pools
    // for the residual count. Decisions already record the matched rows.
    if (!initialAdapterIds.has(poolName)) continue;
    unmatched.push(...txns);
  }

  return { exactDecisions: decisions, unmatched, candidatePool };
}

/**
 * Resolve the rows to carry forward to the next leg based on `outputs.carryForward`.
 *
 *   'matched'   — rows from this leg's decisions (look up source/target txns in the
 *                  snapshot index). For anti-join (matchType='excluded'), these are
 *                  the DROPPED rows, so they are NOT carried forward as matches.
 *   'unmatched' — rows still in pools that NONE of this leg's strategies consumed.
 *                  Useful for "exclude-then-continue" patterns: anti-join with
 *                  consolidated drops already-settled, the residual flows on.
 *   'all'       — everything from BOTH matched and unmatched.
 */
function computeCarryForward(
  leg: ReconcileLeg,
  legDecisions: RecoDecision[],
  sourceIdIndex: Map<string, NormalizedTxn>,
  pools: Map<string, NormalizedTxn[]>,
): NormalizedTxn[] {
  if (!leg.outputs) return [];
  const mode = leg.outputs.carryForward;

  // Rows that THIS leg matched (excluding anti-join drops).
  const matched: NormalizedTxn[] = [];
  const matchedSeen = new Set<string>();
  for (const d of legDecisions) {
    if (d.matchType === 'excluded') continue; // anti-join drops are NOT matches
    for (const id of [d.sourceTxnId, d.targetTxnId]) {
      if (!id || matchedSeen.has(id)) continue;
      const txn = sourceIdIndex.get(id);
      if (txn) {
        matchedSeen.add(id);
        matched.push(txn);
      }
    }
  }

  // Rows still sitting in this leg's `from` pools after the matcher consumed
  // matched rows — i.e. the unmatched residual relative to this leg's matches.
  const fromAdapters = new Set(leg.matches.map(s => s.from));
  const residual: NormalizedTxn[] = [];
  const residualSeen = new Set<string>();
  for (const adapterId of fromAdapters) {
    const remaining = pools.get(adapterId) ?? [];
    for (const t of remaining) {
      if (residualSeen.has(t.sourceId)) continue;
      residualSeen.add(t.sourceId);
      residual.push(t);
    }
  }

  if (mode === 'matched') return matched;
  if (mode === 'unmatched') return residual;
  // 'all' — matched + residual, with sourceId-level dedup.
  const out: NormalizedTxn[] = [...matched];
  const seen = new Set(matched.map(t => t.sourceId));
  for (const t of residual) {
    if (seen.has(t.sourceId)) continue;
    seen.add(t.sourceId);
    out.push(t);
  }
  return out;
}
