/**
 * Generalized matcher — walks a ReconcileConfig's match graph and produces
 * deterministic match decisions + a residual list for the LLM fuzzy stage.
 *
 * Phase 1 extensions (Reconciliation v2):
 *   - Composite join keys: { composite: ['utr','amountPaise','payerVpa'] }
 *   - Field transforms applied to join-key values BOTH sides at match time
 *     (digits_only / lowercase / strip_whitespace / first_n_chars:N / etc.)
 *   - Unified `tolerance` clause primitive (amount + date proximity in one shape)
 *   - `exclude_if_present` strategy (anti-join — drops rows present in RIGHT)
 *   - `runMatchesOnPool()` extracted so the multi-leg runner can call it per leg
 *
 * Backwards-compatible: legacy `amount_tolerance` + `tolerancePaise` strategies
 * continue to work; pre-Phase-1 configs produce byte-identical decisions.
 */

import type {
  MatchStrategy,
  ReconcileConfig,
  JoinKey,
  JoinKeyField,
  FieldTransform,
  ToleranceClause,
} from './adapter.js';
import type { NormalizedTxn, RecoDecision, DecisionMetadata } from './types.js';

// v2.2.0: composite join keys, field transforms, unified tolerance, anti-join.
const MATCHER_VERSION = 'v2.2.0';

// ─── Helpers — join keys, transforms, tolerances ─────────────────────────────

/** Normalise a JoinKey to the array of fields it composes from. */
function joinKeyFields(joinKey: JoinKey): JoinKeyField[] {
  return typeof joinKey === 'string' ? [joinKey] : joinKey.composite;
}

/** Display string for join-key fields, used in customer-readable reasoning. */
function joinKeyDisplay(joinKey: JoinKey): string {
  return joinKeyFields(joinKey).join('+');
}

/**
 * Apply a chain of transforms to a join-key value. Both sides of the equality
 * check go through the same chain so the comparison is symmetric.
 *
 * Returns `null` for missing/empty values so the caller can early-exit.
 */
function applyTransforms(value: string | number | null | undefined, transforms?: FieldTransform[]): string | null {
  if (value === null || value === undefined || value === '') return null;
  let v = String(value);
  if (!transforms || transforms.length === 0) return v;
  for (const t of transforms) {
    if (t === 'digits_only') v = v.replace(/\D/g, '');
    else if (t === 'lowercase') v = v.toLowerCase();
    else if (t === 'uppercase') v = v.toUpperCase();
    else if (t === 'alphanumeric_only') v = v.replace(/[^A-Za-z0-9]/g, '');
    else if (t === 'strip_whitespace') v = v.replace(/\s+/g, '');
    else if (t.startsWith('first_n_chars:')) {
      const n = parseInt(t.slice('first_n_chars:'.length), 10);
      if (Number.isFinite(n) && n > 0) v = v.slice(0, n);
    }
    // Unknown transforms: silently noop (forward-compat).
  }
  return v.length > 0 ? v : null;
}

/**
 * Extract a stable, transform-applied hash string for the join key on a txn.
 * For single-field keys this is just the (transformed) value. For composite
 * keys it's a delimited concatenation. Returns null if ANY required field is
 * missing — composite matches require ALL fields populated.
 */
function joinKeyHash(
  txn: NormalizedTxn,
  joinKey: JoinKey,
  transforms?: FieldTransform[],
  transformsByField?: Partial<Record<string, FieldTransform[]>>,
): string | null {
  const fields = joinKeyFields(joinKey);
  const parts: string[] = [];
  const record = txn as unknown as Record<string, unknown>;
  for (const f of fields) {
    const raw = record[f] as string | number | null | undefined;
    // Per-field override wins; otherwise the strategy-wide transforms apply.
    // (digits_only is right for a numeric RRN but wrong for an alphanumeric VPA.)
    const fieldTransforms = transformsByField?.[f] ?? transforms;
    const norm = applyTransforms(raw as string | number | null | undefined, fieldTransforms);
    if (norm === null) return null; // composite-AND semantics: any missing field disqualifies
    parts.push(norm);
  }
  // \x1f (unit separator) is highly unlikely to occur in real data — safer than '|' or ':'
  return parts.join('\x1f');
}

/** Was any transform actually applied to either side? Reported in audit. */
function transformsApplied(transforms?: FieldTransform[]): string[] {
  return transforms && transforms.length > 0 ? transforms.map(t => `transform:${t}`) : [];
}

/**
 * Resolve effective amount-tolerance clause for a strategy. Translates legacy
 * `amount_tolerance` + `tolerancePaise` into the new tolerance-clause shape
 * so the rest of the code only deals with one form.
 */
function effectiveAmountTolerancePaise(strategy: MatchStrategy, leftAmountPaise: number): number {
  // 1) Legacy `tolerancePaise` wins if explicitly set on a legacy strategy
  if (strategy.tolerancePaise !== undefined && strategy.strategy === 'amount_tolerance') {
    return strategy.tolerancePaise;
  }
  // 2) New tolerance[] form — find the amount clause
  const amountClause = strategy.tolerance?.find(c => c.field === 'amountPaise');
  if (amountClause) {
    if (amountClause.unit === 'paise') return amountClause.amount;
    if (amountClause.unit === 'percent') {
      return Math.round(Math.abs(leftAmountPaise) * (amountClause.amount / 100));
    }
  }
  // 3) Legacy default for amount_tolerance with nothing set: ₹1
  if (strategy.strategy === 'amount_tolerance') return 100;
  // 4) Anything else: zero tolerance
  return 0;
}

/**
 * Resolve effective date-tolerance in days for a strategy, if any.
 * Date tolerance is opt-in via `tolerance: [{ field: 'date', amount, unit: 'day'|'month' }]`.
 */
function effectiveDateToleranceDays(strategy: MatchStrategy): number | null {
  const dateClause = strategy.tolerance?.find(c => c.field === 'date');
  if (!dateClause) return null;
  if (dateClause.unit === 'day') return dateClause.amount;
  if (dateClause.unit === 'month') return dateClause.amount * 30; // approximate
  return null;
}

function dateDiffDays(a: string, b: string): number {
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  if (Number.isNaN(ma) || Number.isNaN(mb)) return Infinity;
  return Math.abs((ma - mb) / 86_400_000);
}

/** Format paise as a customer-readable INR string (₹1,23,456.78). */
function formatRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const rupees = Math.abs(paise) / 100;
  return `${sign}₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

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
 * Backwards-compatible entry point — used for configs that don't declare
 * a multi-leg `legs[]`. For multi-leg configs, the leg runner calls
 * `runMatchesOnPool()` directly per leg.
 */
export function runMatchGraph(
  config: ReconcileConfig,
  fetched: FetchedSource[]
): DeterministicMatchOutput {
  const candidatePool: NormalizedTxn[] = [];
  for (const f of fetched) candidatePool.push(...f.txns);

  const pools = new Map<string, NormalizedTxn[]>();
  for (const f of fetched) pools.set(f.adapterId, [...f.txns]);

  const exactDecisions = runMatchesOnPool(config.matches, pools);

  const unmatched: NormalizedTxn[] = [];
  for (const txns of pools.values()) unmatched.push(...txns);

  return { exactDecisions, unmatched, candidatePool };
}

/**
 * Run an ordered list of match strategies against a shared pools-by-adapter map.
 * MUTATES the pools (consumed rows are removed). Returns the decisions emitted.
 *
 * This is the leg-level primitive: the multi-leg runner calls this once per leg
 * with that leg's strategies, then promotes/demotes pools between legs based on
 * `outputs.carryForward`. The single-leg path (`runMatchGraph`) calls it once
 * with all of config.matches.
 */
export function runMatchesOnPool(
  strategies: MatchStrategy[],
  pools: Map<string, NormalizedTxn[]>,
  legId?: string,
): RecoDecision[] {
  const decisions: RecoDecision[] = [];

  for (const strategy of strategies) {
    const left = pools.get(strategy.from) ?? [];
    const right = pools.get(strategy.to) ?? [];

    // Hi-res timing per strategy so we can spot which match path is slow
    // under production volumes (e.g. anti-join of 80k × 44k composite keys).
    const t0 = process.hrtime.bigint();
    console.log(
      `[reco-match:${strategy.name}${legId ? `@${legId}` : ''}] starting ` +
      `strategy=${strategy.strategy} from=${strategy.from}(${left.length}) to=${strategy.to}(${right.length})`,
    );

    const result = runSingleMatch(strategy, left, right, legId);
    decisions.push(...result.decisions);

    pools.set(strategy.from, result.unmatchedLeft);
    pools.set(strategy.to, result.unmatchedRight);

    const ms = Number(process.hrtime.bigint() - t0) / 1_000_000;
    const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(
      `[reco-match:${strategy.name}${legId ? `@${legId}` : ''}] done in ${ms.toFixed(0)}ms ` +
      `matched=${result.decisions.length} leftResidual=${result.unmatchedLeft.length} ` +
      `rightResidual=${result.unmatchedRight.length} heap=${memMb}MB`,
    );
  }

  return decisions;
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
  right: NormalizedTxn[],
  legId?: string,
): SingleMatchResult {
  switch (strategy.strategy) {
    case 'exact':
      return matchExact(strategy, left, right, legId);
    case 'amount_tolerance':
    case 'tolerance':
      return matchTolerance(strategy, left, right, legId);
    case 'sum_then_match':
      return matchSumThenMatch(strategy, left, right, legId);
    case 'exclude_if_present':
      return matchExcludeIfPresent(strategy, left, right, legId);
  }
}

/** Common metadata fragment recorded on every decision a strategy emits. */
function baseMetadata(strategy: MatchStrategy, legId: string | undefined, joinKey: JoinKey, transforms?: FieldTransform[]): Partial<DecisionMetadata> {
  return {
    strategyName: strategy.name,
    legId,
    ruleId: strategy.ruleId ?? strategy.name,
    ruleSource: 'user',
    joinKeyUsed: joinKeyFields(joinKey),
    normalizations: transformsApplied(transforms),
  };
}

// 1:1 join on joinKey (after transforms); amounts must be EXACTLY equal.
function matchExact(
  strategy: MatchStrategy,
  left: NormalizedTxn[],
  right: NormalizedTxn[],
  legId?: string,
): SingleMatchResult {
  const transforms = strategy.transforms;
  const rightByKey = new Map<string, NormalizedTxn>();
  for (const r of right) {
    const k = joinKeyHash(r, strategy.joinKey, transforms, strategy.transformsByField);
    if (k) rightByKey.set(k, r);
  }

  const decisions: RecoDecision[] = [];
  const unmatchedLeft: NormalizedTxn[] = [];

  for (const l of left) {
    const k = joinKeyHash(l, strategy.joinKey, transforms, strategy.transformsByField);
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
      reasoning: `Reference ${joinKeyDisplay(strategy.joinKey)} and amount match exactly.`,
      metadata: baseMetadata(strategy, legId, strategy.joinKey, transforms),
    });
    rightByKey.delete(k);
  }

  return { decisions, unmatchedLeft, unmatchedRight: Array.from(rightByKey.values()) };
}

/**
 * 1:1 join on joinKey, with one or more tolerance clauses (amount and/or date).
 * Powers both the legacy `amount_tolerance` strategy (via tolerancePaise) and
 * the new `tolerance` strategy (via tolerance[]).
 */
function matchTolerance(
  strategy: MatchStrategy,
  left: NormalizedTxn[],
  right: NormalizedTxn[],
  legId?: string,
): SingleMatchResult {
  const transforms = strategy.transforms;
  const dateTolDays = effectiveDateToleranceDays(strategy);

  const rightByKey = new Map<string, NormalizedTxn>();
  for (const r of right) {
    const k = joinKeyHash(r, strategy.joinKey, transforms, strategy.transformsByField);
    if (k) rightByKey.set(k, r);
  }

  const decisions: RecoDecision[] = [];
  const unmatchedLeft: NormalizedTxn[] = [];

  for (const l of left) {
    const k = joinKeyHash(l, strategy.joinKey, transforms, strategy.transformsByField);
    if (!k) { unmatchedLeft.push(l); continue; }
    const r = rightByKey.get(k);
    if (!r) { unmatchedLeft.push(l); continue; }

    // Amount tolerance (with optional expectedNetPaise commission formula)
    const tol = effectiveAmountTolerancePaise(strategy, l.amountPaise);
    const expected = strategy.expectedNetPaise
      ? strategy.expectedNetPaise(l.amountPaise, l)
      : l.amountPaise;
    const delta = Math.abs(expected - r.amountPaise);
    if (delta > tol) { unmatchedLeft.push(l); continue; }

    // Date tolerance (if declared)
    if (dateTolDays !== null) {
      const ddays = dateDiffDays(l.date, r.date);
      if (ddays > dateTolDays) { unmatchedLeft.push(l); continue; }
    }

    const reasoning = strategy.expectedNetPaise
      ? `Bank credit matches gross ${formatRupees(l.amountPaise)} minus expected fee/commission ` +
        `(expected ${formatRupees(expected)}, received ${formatRupees(r.amountPaise)}, ` +
        `delta ${formatRupees(delta)} within tolerance ${formatRupees(tol)}).`
      : `Match within tolerance: amount delta ${formatRupees(delta)} of ${formatRupees(tol)}` +
        (dateTolDays !== null ? `, date within ${dateTolDays} day(s)` : '') + '.';

    decisions.push({
      sourceTxnId: l.sourceId,
      targetTxnId: r.sourceId,
      matchType: 'tolerance_match',
      amountDeltaPaise: delta,
      decidedBy: 'system',
      matcherVersion: MATCHER_VERSION,
      reasoning,
      metadata: {
        ...baseMetadata(strategy, legId, strategy.joinKey, transforms),
        expectedPaise: expected,
        tolerancePaise: tol,
      },
    });
    rightByKey.delete(k);
  }

  return { decisions, unmatchedLeft, unmatchedRight: Array.from(rightByKey.values()) };
}

// Group LEFT by aggregateBy, sum amounts, match summed total to RIGHT row.
// Bank-credit-side batched settlement pattern (one bank credit = many PG txns).
function matchSumThenMatch(
  strategy: MatchStrategy,
  left: NormalizedTxn[],
  right: NormalizedTxn[],
  legId?: string,
): SingleMatchResult {
  if (!strategy.aggregateBy) {
    throw new Error(`Strategy '${strategy.name}' is sum_then_match but missing aggregateBy`);
  }
  const transforms = strategy.transforms;

  // Group LEFT by aggregateBy (e.g. settlementId)
  const groups = new Map<string, NormalizedTxn[]>();
  for (const l of left) {
    const groupKey = (l as unknown as Record<string, unknown>)[strategy.aggregateBy] as string | null | undefined;
    if (!groupKey) continue;
    const arr = groups.get(groupKey) ?? [];
    arr.push(l);
    groups.set(groupKey, arr);
  }

  // Index RIGHT by join key (transformed)
  const rightByKey = new Map<string, NormalizedTxn>();
  for (const r of right) {
    const k = joinKeyHash(r, strategy.joinKey, transforms, strategy.transformsByField);
    if (k) rightByKey.set(k, r);
  }

  const tol = strategy.tolerancePaise ?? effectiveAmountTolerancePaise(strategy, 0);
  const decisions: RecoDecision[] = [];
  const matchedLeftIds = new Set<string>();

  for (const [groupKey, group] of groups) {
    const sumPaise = group.reduce((a, b) => a + b.amountPaise, 0);
    // All rows in the group should share the join key. Use first row.
    const joinValue = joinKeyHash(group[0], strategy.joinKey, transforms, strategy.transformsByField);
    if (!joinValue) continue;
    const r = rightByKey.get(joinValue);
    if (!r) continue;
    if (Math.abs(r.amountPaise - sumPaise) > tol) continue;

    const reasoning =
      `Batched settlement: ${group.length} transactions totalling ` +
      `${formatRupees(sumPaise)} settled together as one bank credit ` +
      `(batch ${groupKey}).`;
    const metadata: Partial<DecisionMetadata> = {
      ...baseMetadata(strategy, legId, strategy.joinKey, transforms),
      batchId: groupKey,
      batchSize: group.length,
      batchSumPaise: sumPaise,
    };
    for (const l of group) {
      decisions.push({
        sourceTxnId: l.sourceId,
        targetTxnId: r.sourceId,
        matchType: 'batch_match',
        amountDeltaPaise: 0,
        decidedBy: 'system',
        matcherVersion: MATCHER_VERSION,
        reasoning,
        metadata: metadata as DecisionMetadata,
      });
      matchedLeftIds.add(l.sourceId);
    }
    rightByKey.delete(joinValue);
  }

  const unmatchedLeft = left.filter(l => !matchedLeftIds.has(l.sourceId));
  return { decisions, unmatchedLeft, unmatchedRight: Array.from(rightByKey.values()) };
}

/**
 * Anti-join: drop LEFT rows whose join key (after transforms) is present in RIGHT.
 * Emits a decision with matchType='excluded' for each dropped row so the audit
 * trail records WHY it was dropped. The RIGHT pool is untouched.
 *
 * Used for the "Consolidated already-settled" leg: any MIS row whose RRN is
 * already in the Consolidated report must NOT be re-settled.
 */
function matchExcludeIfPresent(
  strategy: MatchStrategy,
  left: NormalizedTxn[],
  right: NormalizedTxn[],
  legId?: string,
): SingleMatchResult {
  const transforms = strategy.transforms;
  const rightKeys = new Set<string>();
  for (const r of right) {
    const k = joinKeyHash(r, strategy.joinKey, transforms, strategy.transformsByField);
    if (k) rightKeys.add(k);
  }

  const decisions: RecoDecision[] = [];
  const unmatchedLeft: NormalizedTxn[] = [];

  for (const l of left) {
    const k = joinKeyHash(l, strategy.joinKey, transforms, strategy.transformsByField);
    if (k && rightKeys.has(k)) {
      decisions.push({
        sourceTxnId: l.sourceId,
        targetTxnId: null, // anti-join doesn't pair to a specific RIGHT row
        matchType: 'excluded',
        amountDeltaPaise: 0,
        decidedBy: 'system',
        matcherVersion: MATCHER_VERSION,
        reasoning: `Excluded — ${joinKeyDisplay(strategy.joinKey)} already present in '${strategy.to}'.`,
        metadata: baseMetadata(strategy, legId, strategy.joinKey, transforms),
      });
    } else {
      unmatchedLeft.push(l);
    }
  }

  // Anti-join does not consume RIGHT — pass all of right through unchanged.
  return { decisions, unmatchedLeft, unmatchedRight: right };
}
