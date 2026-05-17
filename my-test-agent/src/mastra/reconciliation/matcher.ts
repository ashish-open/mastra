/**
 * Generalized matcher — walks a ReconcileConfig's match graph and produces
 * exact-match decisions + a residual list for the LLM fuzzy stage.
 *
 * Replaces the two hardcoded match functions (matchInternalToPG, matchPGToBank)
 * with a config-driven loop, so adding a new platform = config change, not
 * code change.
 */

import type { MatchStrategy, ReconcileConfig } from './adapter.js';
import type { NormalizedTxn, RecoDecision } from './types.js';

const MATCHER_VERSION = 'v2.0.0';  // bump on any matcher-logic change

interface FetchedSource {
  adapterId: string;
  txns: NormalizedTxn[];
}

export interface DeterministicMatchOutput {
  exactDecisions: RecoDecision[];
  unmatched: NormalizedTxn[];       // residual that flows to fuzzy stage
  candidatePool: NormalizedTxn[];   // all txns from all sources (for fuzzy)
}

/**
 * Run every match strategy in config.matches against the fetched data.
 * Each match strategy "consumes" rows on both sides — consumed rows won't be
 * offered to subsequent matches.
 */
export function runMatchGraph(
  config: ReconcileConfig,
  fetched: FetchedSource[]
): DeterministicMatchOutput {
  // Index by adapter id, mutable so we can remove "consumed" rows
  const pools = new Map<string, NormalizedTxn[]>();
  for (const f of fetched) pools.set(f.adapterId, [...f.txns]);

  const exactDecisions: RecoDecision[] = [];

  for (const strategy of config.matches) {
    const left = pools.get(strategy.from) ?? [];
    const right = pools.get(strategy.to) ?? [];

    const result = runSingleMatch(strategy, left, right);
    exactDecisions.push(...result.decisions);

    // Replace pools with unmatched residuals
    pools.set(strategy.from, result.unmatchedLeft);
    pools.set(strategy.to, result.unmatchedRight);

    console.log(
      `[reco-match:${strategy.name}] from=${strategy.from} to=${strategy.to} ` +
      `matched=${result.decisions.length} ` +
      `leftResidual=${result.unmatchedLeft.length} rightResidual=${result.unmatchedRight.length}`
    );
  }

  // Anything left in any pool after all strategies have run is residual for fuzzy
  const unmatched: NormalizedTxn[] = [];
  const candidatePool: NormalizedTxn[] = [];
  for (const f of fetched) candidatePool.push(...f.txns);
  for (const txns of pools.values()) unmatched.push(...txns);

  return { exactDecisions, unmatched, candidatePool };
}

// ─── Single match strategies ─────────────────────────────────────────────────

interface SingleMatchResult {
  decisions: RecoDecision[];
  unmatchedLeft: NormalizedTxn[];
  unmatchedRight: NormalizedTxn[];
}

function runSingleMatch(
  strategy: MatchStrategy,
  left: NormalizedTxn[],
  right: NormalizedTxn[]
): SingleMatchResult {
  switch (strategy.strategy) {
    case 'exact':
      return matchExact(strategy, left, right);
    case 'amount_tolerance':
      return matchAmountTolerance(strategy, left, right);
    case 'sum_then_match':
      return matchSumThenMatch(strategy, left, right);
  }
}

// 1:1 join on joinKey; amounts must be EXACTLY equal
function matchExact(
  strategy: MatchStrategy,
  left: NormalizedTxn[],
  right: NormalizedTxn[]
): SingleMatchResult {
  const rightByKey = new Map<string, NormalizedTxn>();
  for (const r of right) {
    const k = (r as Record<string, unknown>)[strategy.joinKey] as string | null | undefined;
    if (k) rightByKey.set(k, r);
  }

  const decisions: RecoDecision[] = [];
  const unmatchedLeft: NormalizedTxn[] = [];

  for (const l of left) {
    const k = (l as Record<string, unknown>)[strategy.joinKey] as string | null | undefined;
    if (!k) { unmatchedLeft.push(l); continue; }
    const r = rightByKey.get(k);
    if (!r || l.amountPaise !== r.amountPaise) { unmatchedLeft.push(l); continue; }
    decisions.push({
      sourceTxnId: l.sourceId,
      targetTxnId: r.sourceId,
      matchType: 'exact',
      amountDeltaPaise: 0,
      decidedBy: 'system',
      matcherVersion: MATCHER_VERSION,
      reasoning: `exact: ${strategy.name} (joinKey=${strategy.joinKey})`,
    });
    rightByKey.delete(k);
  }

  return { decisions, unmatchedLeft, unmatchedRight: Array.from(rightByKey.values()) };
}

// 1:1 join on joinKey; allow amount delta up to tolerancePaise (and optional
// expectedNetPaise() formula for marketplace commission deductions)
function matchAmountTolerance(
  strategy: MatchStrategy,
  left: NormalizedTxn[],
  right: NormalizedTxn[]
): SingleMatchResult {
  const tol = strategy.tolerancePaise ?? 100;  // ₹1 default
  const rightByKey = new Map<string, NormalizedTxn>();
  for (const r of right) {
    const k = (r as Record<string, unknown>)[strategy.joinKey] as string | null | undefined;
    if (k) rightByKey.set(k, r);
  }

  const decisions: RecoDecision[] = [];
  const unmatchedLeft: NormalizedTxn[] = [];

  for (const l of left) {
    const k = (l as Record<string, unknown>)[strategy.joinKey] as string | null | undefined;
    if (!k) { unmatchedLeft.push(l); continue; }
    const r = rightByKey.get(k);
    if (!r) { unmatchedLeft.push(l); continue; }

    // If the strategy gave us a commission formula, compute the expected net
    const expected = strategy.expectedNetPaise
      ? strategy.expectedNetPaise(l.amountPaise, l)
      : l.amountPaise;
    const delta = Math.abs(expected - r.amountPaise);
    if (delta > tol) { unmatchedLeft.push(l); continue; }

    decisions.push({
      sourceTxnId: l.sourceId,
      targetTxnId: r.sourceId,
      matchType: 'exact',
      amountDeltaPaise: delta,
      decidedBy: 'system',
      matcherVersion: MATCHER_VERSION,
      reasoning: `amount_tolerance: ${strategy.name} (delta=${delta}p, tol=${tol}p)`,
    });
    rightByKey.delete(k);
  }

  return { decisions, unmatchedLeft, unmatchedRight: Array.from(rightByKey.values()) };
}

// Group LEFT by aggregateBy, sum amounts, match summed total to RIGHT row.
// This is the marketplace-batched-settlement pattern.
function matchSumThenMatch(
  strategy: MatchStrategy,
  left: NormalizedTxn[],
  right: NormalizedTxn[]
): SingleMatchResult {
  if (!strategy.aggregateBy) {
    throw new Error(`Strategy '${strategy.name}' is sum_then_match but missing aggregateBy`);
  }

  // Group LEFT by aggregateBy (e.g. settlementId)
  const groups = new Map<string, NormalizedTxn[]>();
  for (const l of left) {
    const groupKey = (l as Record<string, unknown>)[strategy.aggregateBy] as string | null | undefined;
    if (!groupKey) continue;
    const arr = groups.get(groupKey) ?? [];
    arr.push(l);
    groups.set(groupKey, arr);
  }

  // Index RIGHT by join key
  const rightByKey = new Map<string, NormalizedTxn>();
  for (const r of right) {
    const k = (r as Record<string, unknown>)[strategy.joinKey] as string | null | undefined;
    if (k) rightByKey.set(k, r);
  }

  const tol = strategy.tolerancePaise ?? 0;
  const decisions: RecoDecision[] = [];
  const matchedLeftIds = new Set<string>();

  for (const [groupKey, group] of groups) {
    const sumPaise = group.reduce((a, b) => a + b.amountPaise, 0);
    // All rows in the group should share the join key (e.g. UTR)
    const joinValue = (group[0] as Record<string, unknown>)[strategy.joinKey] as string | null | undefined;
    if (!joinValue) continue;
    const r = rightByKey.get(joinValue);
    if (!r) continue;
    if (Math.abs(r.amountPaise - sumPaise) > tol) continue;

    // Emit one decision per LEFT row in the group, all pointing to the same RIGHT
    for (const l of group) {
      decisions.push({
        sourceTxnId: l.sourceId,
        targetTxnId: r.sourceId,
        matchType: 'exact',
        amountDeltaPaise: 0,
        decidedBy: 'system',
        matcherVersion: MATCHER_VERSION,
        reasoning: `sum_then_match: ${strategy.name} (batch=${groupKey}, sum=${sumPaise}p)`,
      });
      matchedLeftIds.add(l.sourceId);
    }
    rightByKey.delete(joinValue);
  }

  const unmatchedLeft = left.filter(l => !matchedLeftIds.has(l.sourceId));
  return { decisions, unmatchedLeft, unmatchedRight: Array.from(rightByKey.values()) };
}
