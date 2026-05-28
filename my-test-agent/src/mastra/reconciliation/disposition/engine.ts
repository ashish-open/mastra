/**
 * Deterministic disposition engine — pure-rule code, no LLM.
 *
 * The engine walks an ordered list of `DispositionRule` objects, first-match-
 * wins, against a `DispositionContext` describing a single MIS row's
 * complete reconciliation state across all legs. It returns the bucket the
 * row lands in (settle / refund / ignore / escalate) plus the rule id and
 * plain-English reason text that fired.
 *
 * Why deterministic-only (Principle 1 of the reco v2 plan):
 *   Settlement is audit-critical money work. Same input → same output, every
 *   run, forever. No LLM. Every rule and every fire is reproducible by reading
 *   the rules file. Auditor question "why did this settle?" answers as
 *   "rule X fired because field A=y and field B=z" — not "the LLM decided".
 *
 * Per-config rule sets live in `disposition/<configId>.ts` (e.g.
 * `disposition/settlement-yes-pg.ts`). Each module registers its rules with
 * `registerDispositionRules(configId, rules)`. The workflow looks them up by
 * configId at run time.
 */

import type { NormalizedTxn, RecoDecision, SettlementBucket, RuleSource, DispositionMetadata, MatchType } from '../types.js';

/**
 * Everything a rule needs to decide a single MIS row's fate. Built by the
 * workflow after the leg cascade runs, from the per-MIS-row leg outcomes.
 */
export interface DispositionContext {
  /** The MIS row we are deciding the fate of. */
  misRow: NormalizedTxn;
  /** PG Incoming counterpart that matched in Leg 1, if any. */
  pgIncomingRow: NormalizedTxn | null;
  /** True iff the row's composite key appeared in the Consolidated already-settled list. */
  inConsolidated: boolean;
  /** Bank statement row that matched in Leg 4 (cash truth), if any. */
  bankRow: NormalizedTxn | null;
  /**
   * Auto-refund record (from the open_prod refunds source) matched by the MIS
   * row's `utr` (= refund `bank_rrn`), if any. `raw._refundStatusCode` holds
   * 'S' (success) | 'F' (failed) | '' (pending). Null when no refund exists for
   * this MIS row — meaning it was NOT auto-refunded.
   */
  refundRow: NormalizedTxn | null;
}

/**
 * A disposition rule. `when(ctx)` returns true iff this rule fires for the
 * given MIS row's context. Rules are evaluated TOP-DOWN, first-match-wins —
 * order rules in the array from most specific to most general.
 *
 * `reasonText` is rendered into the exception report and (eventually) the
 * report-pack CSV. Keep it readable by finance ops — no jargon, mention the
 * specific signals that fired (e.g. "Late Authorized in PG").
 */
export interface DispositionRule {
  id: string;
  /** Provenance — defaults to 'user' if omitted. AI-suggested rules pass 'ai'. */
  source?: RuleSource;
  when: (ctx: DispositionContext) => boolean;
  bucket: SettlementBucket;
  reasonText: string | ((ctx: DispositionContext) => string);
}

// ─── Registry ────────────────────────────────────────────────────────────────

interface DispositionRegistration {
  rules: DispositionRule[];
  apply: ApplyDispositionConfig;
}

const REGISTRY = new Map<string, DispositionRegistration>();

/**
 * Register a rule set + workflow-application config for a reco config.
 * Last registration wins (warns on overwrite).
 *
 * The `apply` block tells the workflow which adapter is the anchor (one
 * summary decision per row), and which legId in the config corresponds to
 * each step the rules reference (match, anti-join, bank).
 */
export function registerDispositionRules(
  configId: string,
  rules: DispositionRule[],
  apply: ApplyDispositionConfig,
): void {
  if (REGISTRY.has(configId)) {
    console.warn(`[disposition] rules for '${configId}' are being re-registered; overwriting.`);
  }
  REGISTRY.set(configId, { rules, apply });
}

/** Look up rules + apply config for a configId. Returns null when none registered. */
export function getDispositionRules(configId: string): DispositionRegistration | null {
  return REGISTRY.get(configId) ?? null;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Walk rules top-to-bottom, first-match-wins. Returns the DispositionMetadata
 * to attach to the MIS row's summary decision, or null when no rule fired
 * (callers route to `no_disposition` bucket as a safety net).
 */
export function evaluateRules(rules: DispositionRule[], ctx: DispositionContext): DispositionMetadata | null {
  for (const r of rules) {
    if (r.when(ctx)) {
      const reasonText = typeof r.reasonText === 'function' ? r.reasonText(ctx) : r.reasonText;
      return {
        bucket: r.bucket,
        ruleId: r.id,
        ruleSource: r.source ?? 'user',
        reasonText,
      };
    }
  }
  return null;
}

// ─── Small helpers shared across rule sets ───────────────────────────────────

/** Read a raw field from a NormalizedTxn (handles the `raw` blob safely). */
export function rawField(txn: NormalizedTxn | null | undefined, key: string): string {
  if (!txn || !txn.raw) return '';
  const v = (txn.raw as Record<string, unknown>)[key];
  return v === null || v === undefined ? '' : String(v);
}

/** Case-insensitive value-in-set check. Empty value → false. */
export function statusMatches(value: string, accepted: string[]): boolean {
  if (!value) return false;
  const lc = value.trim().toLowerCase();
  return accepted.some(a => a.trim().toLowerCase() === lc);
}

// ─── Workflow integration ────────────────────────────────────────────────────

/**
 * Configuration for how to apply a rule set across a full reco run.
 *
 * For YES Bank settlement (and any similar PG settlement workflow), the MIS
 * file is the "anchor": every MIS row gets one summary decision recording
 * its final bucket. PG Incoming, Bank, Consolidated rows are looked up
 * relative to the MIS row's matches/exclusions across legs.
 */
export interface ApplyDispositionConfig {
  /** Adapter id whose rows are the anchors for disposition (one decision per row). */
  anchorAdapterId: string;
  /** Adapter id of the PG-incoming-side source (the leg-1 match target). */
  pgIncomingAdapterId: string;
  /** Adapter id of the bank-statement-side source (the leg-4 match target). */
  bankAdapterId: string;
  /** legId of the leg that matches anchor ↔ pgIncoming. */
  matchLegId: string;
  /** legId of the anti-join-against-consolidated leg. */
  antiJoinLegId: string;
  /** legId of the bank-credit leg. */
  bankLegId: string;
  /**
   * Optional: adapterId of a refunds source (e.g. 'yes-auto-refunds'). When set,
   * the engine indexes its rows by `utr` and attaches the matching refund record
   * to each anchor row's `ctx.refundRow`, so rules can classify auto-refunds by
   * `pg_refund_status_code`.
   */
  refundsAdapterId?: string;
  /**
   * Optional: predicate that flags an anchor row as an auto-refund CANDIDATE —
   * i.e. one whose RRN should be looked up in the refunds DB. Evaluated AFTER
   * the legs run (PG/Consolidated membership known) but BEFORE the refund
   * lookup, so `ctx.refundRow` is null here. The YES config uses
   * `Success in MIS && no PG row && not in Consolidated`. Drives
   * `selectAutoRefundCandidateRrns` for the lookup-by-RRN flow.
   */
  autoRefundCandidate?: (ctx: DispositionContext) => boolean;
  /**
   * Optional: capture a cross-file status snapshot for each anchor row, stashed
   * on the summary decision's `disposition.statuses`. Keeps workflow-specific
   * status keys (e.g. YES's `_transactionStatus`) out of the generic engine.
   * The exception report renders these columns.
   */
  statusSnapshot?: (ctx: DispositionContext) => Record<string, string | boolean | undefined>;
}

/**
 * Walk every anchor row (MIS rows), assemble its cross-leg context, evaluate
 * the rule set, and emit ONE summary RecoDecision per anchor row carrying
 * the disposition metadata.
 *
 * Anchor rows that didn't match anywhere still get a summary — the
 * disposition rules handle that (the YES rule set's first rule is
 * "escalate_missing_pg" specifically for this case).
 *
 * The returned decisions are SEPARATE from the per-leg decisions: leg-level
 * decisions remain in place for traceability; summary decisions drive the
 * report-pack bucket categorisation.
 *
 * matcherVersion is required on every decision — we tag summaries with
 * `disposition-v1.0` so audit can distinguish them from matcher-emitted rows.
 */
/** Digits-only RRN key — survives leading-zero / formatting drift across files. */
function refundRrnKey(utr: string | null | undefined): string {
  return (utr ?? '').replace(/\D/g, '');
}

/** Per-MIS-row context plus the matched PG/bank source ids (for the summary's targetTxnId). */
interface MisContextRow {
  ctx: DispositionContext;
  pgIncomingId: string | null;
  bankId: string | null;
}

/**
 * Build the cross-leg context for every anchor (MIS) row. Shared by
 * `applyDispositionRules` and `selectAutoRefundCandidateRrns`, so the
 * leg-decision indexing + per-row context assembly lives in exactly one place.
 *
 * `ctx.refundRow` is populated from the refunds source in `fetched` (keyed by
 * RRN). It's null when that source isn't present yet — which is exactly the
 * state during candidate selection, before the refund lookup runs.
 */
function buildMisContexts(
  fetched: Array<{ adapterId: string; txns: NormalizedTxn[] }>,
  decisions: RecoDecision[],
  config: ApplyDispositionConfig,
): MisContextRow[] {
  const anchors = (fetched.find(f => f.adapterId === config.anchorAdapterId)?.txns) ?? [];
  const incomingById = new Map((fetched.find(f => f.adapterId === config.pgIncomingAdapterId)?.txns ?? []).map(t => [t.sourceId, t]));
  const bankById = new Map((fetched.find(f => f.adapterId === config.bankAdapterId)?.txns ?? []).map(t => [t.sourceId, t]));

  const refundByRrn = new Map<string, NormalizedTxn>();
  if (config.refundsAdapterId) {
    for (const r of (fetched.find(f => f.adapterId === config.refundsAdapterId)?.txns ?? [])) {
      const k = refundRrnKey(r.utr);
      if (k && !refundByRrn.has(k)) refundByRrn.set(k, r);
    }
  }

  // Index decisions by leg + sourceTxnId (and by targetTxnId for the anti-join,
  // since carry-forward can put either side of leg-1 into leg-3's pool).
  const matchedPgBySrc = new Map<string, string>();
  const excludedSrcIds = new Set<string>();
  const bankBySrc = new Map<string, string>();
  for (const d of decisions) {
    const legId = d.metadata?.legId;
    if (legId === config.matchLegId && d.matchType === 'exact' && d.targetTxnId) {
      matchedPgBySrc.set(d.sourceTxnId, d.targetTxnId);
    } else if (legId === config.antiJoinLegId && d.matchType === 'excluded') {
      excludedSrcIds.add(d.sourceTxnId);
      if (d.targetTxnId) excludedSrcIds.add(d.targetTxnId);
    } else if (legId === config.bankLegId && d.targetTxnId) {
      bankBySrc.set(d.sourceTxnId, d.targetTxnId);
    }
  }

  const out: MisContextRow[] = [];
  for (const misRow of anchors) {
    const pgIncomingId = matchedPgBySrc.get(misRow.sourceId) ?? null;
    const pgIncomingRow = pgIncomingId ? incomingById.get(pgIncomingId) ?? null : null;
    const inConsolidated = excludedSrcIds.has(misRow.sourceId) ||
      (pgIncomingId !== null && excludedSrcIds.has(pgIncomingId));
    const bankId = bankBySrc.get(misRow.sourceId)
      ?? (pgIncomingId ? bankBySrc.get(pgIncomingId) : undefined)
      ?? null;
    const bankRow = bankId ? bankById.get(bankId) ?? null : null;
    const refundRow = refundByRrn.get(refundRrnKey(misRow.utr)) ?? null;
    out.push({ ctx: { misRow, pgIncomingRow, inConsolidated, bankRow, refundRow }, pgIncomingId, bankId });
  }
  return out;
}

/**
 * Select the RRNs to look up in the auto-refund DB: anchor (MIS) rows the config
 * flags as auto-refund candidates (YES: Success in MIS, no PG row, not in
 * Consolidated). Returns their MIS `utr` values (= refund `bank_rrn`). Empty
 * when the config provides no `autoRefundCandidate` predicate.
 *
 * Lookup-by-RRN: run AFTER the legs (PG/Consolidated membership known) and
 * BEFORE the refund lookup — exactly the missing-success set, nothing more.
 */
export function selectAutoRefundCandidateRrns(args: {
  fetched: Array<{ adapterId: string; txns: NormalizedTxn[] }>;
  decisions: RecoDecision[];
  config: ApplyDispositionConfig;
}): string[] {
  const predicate = args.config.autoRefundCandidate;
  if (!predicate) return [];
  const rrns = new Set<string>();
  for (const { ctx } of buildMisContexts(args.fetched, args.decisions, args.config)) {
    if (ctx.misRow.utr && predicate(ctx)) rrns.add(ctx.misRow.utr);
  }
  return Array.from(rrns);
}

export function applyDispositionRules(args: {
  fetched: Array<{ adapterId: string; txns: NormalizedTxn[] }>;
  decisions: RecoDecision[];
  rules: DispositionRule[];
  config: ApplyDispositionConfig;
}): RecoDecision[] {
  const { fetched, decisions, rules, config } = args;
  const summaries: RecoDecision[] = [];

  for (const { ctx, pgIncomingId, bankId } of buildMisContexts(fetched, decisions, config)) {
    const outcome = evaluateRules(rules, ctx);
    const disposition: DispositionMetadata = outcome ?? {
      bucket: 'no_disposition',
      ruleId: 'no_rule_fired',
      ruleSource: 'default',
      reasonText: 'No disposition rule fired for this row — operator review required.',
    };

    // Cross-file status snapshot for the exception report. Drop undefined values
    // so the persisted JSON stays clean. Structural statuses are always present;
    // the optional hook adds workflow-specific text statuses (MIS/PG/refund).
    const rawSnapshot: Record<string, string | boolean | undefined> = {
      pgIncomingMatched: ctx.pgIncomingRow !== null,
      inConsolidated: ctx.inConsolidated,
      bankCredit: ctx.bankRow !== null,
      ...(config.statusSnapshot ? config.statusSnapshot(ctx) : {}),
    };
    const statuses: Record<string, string | boolean> = {};
    for (const [k, v] of Object.entries(rawSnapshot)) {
      if (v !== undefined) statuses[k] = v;
    }
    disposition.statuses = statuses;

    summaries.push({
      sourceTxnId: ctx.misRow.sourceId,
      targetTxnId: pgIncomingId ?? bankId ?? null,
      matchType: bucketToMatchType(disposition.bucket),
      amountDeltaPaise: 0,
      decidedBy: 'system',
      matcherVersion: 'disposition-v1.0',
      reasoning: disposition.reasonText,
      metadata: {
        strategyName: 'deterministic_disposition',
        legId: 'disposition_summary',
        ruleId: disposition.ruleId,
        ruleSource: disposition.ruleSource,
        disposition,
      },
    });
  }
  return summaries;
}

/** Map a settlement bucket onto the existing MatchType enum so today's UI / DB layer continues to work. */
function bucketToMatchType(bucket: SettlementBucket): MatchType {
  switch (bucket) {
    case 'settled_next_day': return 'exact';            // to be settled (T+2)
    case 'settled_instant': return 'excluded';          // already instant-settled (in Consolidated)
    case 'refund_late_authorized':
    case 'refund_timeout': return 'tolerance_match';    // refund-to-source action
    case 'auto_refund_success':                         // refund completed — money returned
    case 'ignore_failed': return 'written_off';         // closed — no settlement action
    case 'auto_refund_failed':                          // refund FAILED — money stuck, needs action
    case 'auto_refund_pending':                         // refund not yet confirmed
    case 'awaiting_bank_credit':                        // funds not yet in bank — hold, do NOT settle
    case 'not_settled_checking':
    case 'no_disposition': return 'pending_review';     // needs a human look
  }
}
