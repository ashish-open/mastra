/**
 * Canonical schemas for the statement-reconciliation pipeline.
 *
 * All three sources (internal ledger, PG settlements, bank statement) get
 * normalized into NormalizedTxn so downstream matchers don't care where the
 * data came from.
 */

import { z } from 'zod';

// ─── Canonical normalized transaction ────────────────────────────────────────

/**
 * Transaction payment mode. PG partners often ship separate files per mode
 * (one for UPI, one for credit-card, etc.). Storing mode lets one ReconcileConfig
 * span several modes without colliding in the staging table.
 */
export const TransactionModeSchema = z.enum(['UPI', 'CC', 'DC', 'NB', 'OTHER']);
export type TransactionMode = z.infer<typeof TransactionModeSchema>;

export const NormalizedTxnSchema = z.object({
  /** Source-specific original ID */
  sourceId: z.string(),
  /**
   * Which system this came from. Historically an enum (`internal`|`pg`|`bank`);
   * widened to free-form string in Phase 1 so multi-leg configs can name sources
   * like `yes-pg-mis`, `yes-pg-incoming`, `yes-bank`, `internal-pg-db`. Existing
   * values still validate.
   */
  source: z.string(),
  /** Amount in paise (always integer — never use floats for money) */
  amountPaise: z.number().int(),
  /** ISO date (yyyy-mm-dd) the txn occurred in the source's books */
  date: z.string(),
  /** Payment mode if known. Lets a single config span UPI + CC + DC files per PG. */
  mode: TransactionModeSchema.optional(),
  /** Bank UTR / RRN — populated when known. Bank-credit rows always have it; internal rows may not. */
  utr: z.string().nullable().optional(),
  /** Merchant-side reference IDs we set when initiating */
  merchantRefId: z.string().nullable().optional(),
  /** PG-side settlement batch ID (groups payments into one bank credit) */
  settlementId: z.string().nullable().optional(),
  /**
   * Our internal PG-transaction id (e.g. `py_086A0F2B5841279`). Populated by
   * the internal-ledger / `internal-pg-db` adapter so reco decisions can
   * deep-link back into our system. Out-of-the-box PG MIS files don't carry
   * this — we have to look it up via composite (utr+amount+vpa) match.
   */
  pyId: z.string().nullable().optional(),
  /**
   * Payer Virtual Payment Address (UPI) — used as part of the composite join
   * key for UPI legs where UTR alone is not unique (NPCI RRN collisions across
   * partners, retry duplicates, etc.).
   */
  payerVpa: z.string().nullable().optional(),
  /** Free-form description from the source */
  description: z.string().optional(),
  /** Counterparty name/account — used in fuzzy matching */
  counterparty: z.string().nullable().optional(),
  /** Raw source payload, retained for audit */
  raw: z.record(z.string(), z.unknown()).optional(),
});
export type NormalizedTxn = z.infer<typeof NormalizedTxnSchema>;

// ─── Match decisions ─────────────────────────────────────────────────────────

export const MatchTypeSchema = z.enum([
  'exact',           // deterministic 1:1, amounts EQUAL on shared joinKey
  'tolerance_match', // deterministic 1:1, amounts within tolerance (e.g. marketplace
                     //   commission/fee deducted before bank credit)
  'batch_match',     // N:1 — many source txns settle as one batch credit;
                     //   sum(source.amount) == bank.amount, all share the same UTR
  'excluded',        // anti-join hit (e.g. row is present in Consolidated → already settled,
                     //   drop from settle bucket). Records the exclusion for audit.
  'fuzzy_auto',      // LLM suggested with high confidence, auto-accepted
  'fuzzy_human',     // LLM suggested, human approved
  'pending_review',  // system queued for human reviewer (suspend/resume target)
  'unmatched',       // no candidate found AND no fraud signals AND not eligible for write-off
  'written_off',     // small + old: auto-resolved as not worth chasing
  'flagged_fraud',   // active fraud signals detected
]);
export type MatchType = z.infer<typeof MatchTypeSchema>;

/**
 * Customer-facing labels + visual tone for each match type. Surfaced via
 * `/integration/info` so OpenArc (and any future UI) can render consistent
 * badges without shipping a release every time we add a new internal type.
 *
 * Keep labels readable by a finance ops user — not engineering jargon.
 */
export const MATCH_TYPE_LABELS: Record<
  MatchType,
  { label: string; tone: 'success' | 'info' | 'warning' | 'danger'; description: string }
> = {
  exact:           { label: 'Matched',                tone: 'success', description: 'Reference and amount match exactly.' },
  tolerance_match: { label: 'Matched (with fee)',     tone: 'success', description: 'Amount matches after deducting expected commission, GST or fee.' },
  batch_match:     { label: 'Matched (batched)',      tone: 'success', description: 'Multiple source transactions settle together as one bank credit.' },
  excluded:        { label: 'Excluded (already settled)', tone: 'info', description: 'Row was present in a reference set (e.g. already-settled list) and dropped from this run.' },
  fuzzy_auto:      { label: 'Matched (AI)',           tone: 'success', description: 'AI matched on similarity — high confidence, auto-approved.' },
  fuzzy_human:     { label: 'Matched (verified)',     tone: 'success', description: 'AI suggested, human reviewer confirmed.' },
  pending_review:  { label: 'Needs review',           tone: 'warning', description: 'Queued for a human reviewer — confidence too low to auto-decide.' },
  unmatched:       { label: 'Unmatched',              tone: 'warning', description: 'No matching counterparty found and no clear next action.' },
  written_off:     { label: 'Written off',            tone: 'info',    description: 'Small and aged — auto-closed as not worth chasing.' },
  flagged_fraud:   { label: 'Fraud alert',            tone: 'danger',  description: 'Pattern matches known fraud signals — escalate.' },
};

/**
 * Structured details a decision can carry alongside the free-text reasoning.
 * This is what a UI tooltip / details drawer renders — `reasoning` stays
 * present for human readability and audit logs.
 */
/**
 * Provenance of a rule. Used on disposition rules + column mappings so every
 * configuration artifact carries who authored it. Borrowed from EndClose.
 */
export const RuleSourceSchema = z.enum(['user', 'ai', 'default']);
export type RuleSource = z.infer<typeof RuleSourceSchema>;

/**
 * Lifecycle of a rule. `proposed` rules are persisted but DO NOT influence
 * reconciliation outcomes — they sit waiting for explicit operator activation.
 * AI-authored rules always start `proposed`. Borrowed from EndClose.
 */
export const RuleStatusSchema = z.enum(['proposed', 'active']);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

/**
 * Final settlement-bucket each MIS row lands in after the disposition engine
 * runs. Drives the report-pack split (settle vs refund vs escalate vs ignore)
 * and the eventual `settlement_upload.csv` content.
 *
 * Keep this enum stable — it's a contract with the finance team's existing
 * Excel workflow. New buckets need a finance-team sign-off conversation first.
 */
export const SettlementBucketSchema = z.enum([
  'settled_instant',            // Present in Consolidated (instant-settled, every ~15 min) — already paid
  'settled_next_day',           // Success + captured + bank credit received + NOT instant-settled → settle T+2
  'awaiting_bank_credit',       // Success + captured + NOT instant-settled but NO bank credit yet → hold, do NOT settle
  'refund_late_authorized',     // MIS Success, PG Late Authorized, bank credit → refund to source
  'refund_timeout',             // MIS Timeout, PG Failed/Timeout, bank credit → refund to source
  'auto_refund_success',        // MIS Success, no PG row, refund record with status 'S' → refunded OK (no action)
  'auto_refund_failed',         // MIS Success, no PG row, refund record with status 'F' → refund FAILED (money stuck — action!)
  'auto_refund_pending',        // MIS Success, no PG row, refund record status blank/null → refund pending
  'ignore_failed',              // Failed in both, no bank credit → no action
  'not_settled_checking',       // Anything else — checking internally
  'no_disposition',             // Engine safety net (no rule fired) — should be rare
]);
export type SettlementBucket = z.infer<typeof SettlementBucketSchema>;

/**
 * Finance-facing labels per bucket — VERBATIM from the recon person's current
 * Excel pivot so the generated summary reads identically to what they circulate
 * today. Changing these labels is a finance-team conversation, not a code call.
 */
export const SETTLEMENT_BUCKET_LABELS: Record<SettlementBucket, string> = {
  settled_instant:         'Settled to merchant (Instant)',
  settled_next_day:        'Settled to merchant (Next day Settlement)',
  awaiting_bank_credit:    'Awaiting Bank Credit',
  refund_late_authorized:  'Late Authorised (Need to initiate refund)',
  refund_timeout:          'TIMEOUT (Need to initiate refund)',
  auto_refund_success:     'Auto Refunded (Success)',
  auto_refund_failed:      'Auto Refund FAILED',
  auto_refund_pending:     'Auto Refund Pending',
  ignore_failed:           'Failed (No funds — no action)',
  not_settled_checking:    'Not Settled (Checking Internally)',
  no_disposition:          'Uncategorised (review)',
};

/**
 * Fixed display order for the summary pivot (mirrors the finance Excel layout).
 * Buckets not listed fall to the end.
 */
export const SETTLEMENT_BUCKET_ORDER: SettlementBucket[] = [
  'settled_instant',
  'settled_next_day',
  'awaiting_bank_credit',
  'refund_late_authorized',
  'refund_timeout',
  'auto_refund_success',
  'auto_refund_failed',
  'auto_refund_pending',
  'ignore_failed',
  'not_settled_checking',
  'no_disposition',
];

/** Disposition outcome recorded on each top-level decision. */
export const DispositionMetadataSchema = z.object({
  bucket: SettlementBucketSchema,
  ruleId: z.string(),
  ruleSource: RuleSourceSchema,
  /** Plain-English explanation for the finance ops user. Goes into the exception report. */
  reasonText: z.string(),
  /**
   * Cross-file status snapshot for the anchor (MIS) row, captured at decision
   * time. Drives the exception report's "what's the status in MIS / PG / bank"
   * columns without the report builder having to re-derive them. Flexible
   * record so each workflow's rule set decides which statuses are meaningful
   * (e.g. YES settlement records misStatus, pgIncomingStatus, inConsolidated,
   * bankCredit).
   */
  statuses: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
});
export type DispositionMetadata = z.infer<typeof DispositionMetadataSchema>;

export const DecisionMetadataSchema = z
  .object({
    /** Strategy name from ReconcileConfig.matches[].name (e.g. 'razorpay_batch_to_bank'). */
    strategyName: z.string().optional(),
    /** Which leg in a multi-leg config matched this row (e.g. 'leg-1-pg-mis-vs-incoming'). */
    legId: z.string().optional(),
    /** Which deterministic rule fired (e.g. 'composite_exact_match', 'excluded_in_consolidated'). */
    ruleId: z.string().optional(),
    /** Who authored the rule that produced this decision. */
    ruleSource: RuleSourceSchema.optional(),
    /** Which fields' equality (after transforms) produced the match. */
    joinKeyUsed: z.array(z.string()).optional(),
    /**
     * Auto-normalisations applied at parse or match time, recorded for audit
     * so finance team can trace whether (e.g.) zero-padding influenced a match.
     * Examples: 'zero_padded_utr', 'digits_only:utr', 'lowercase:counterparty'.
     */
    normalizations: z.array(z.string()).optional(),
    /** Settlement / batch identifier for batch_match (e.g. 'setl_PLN0003'). */
    batchId: z.string().optional(),
    /** Number of source txns aggregated into this batch (batch_match only). */
    batchSize: z.number().int().optional(),
    /** Total summed amount in paise for the batch (batch_match only). */
    batchSumPaise: z.number().int().optional(),
    /** Expected post-commission amount in paise (tolerance_match only). */
    expectedPaise: z.number().int().optional(),
    /** Allowed amount delta in paise for tolerance_match (echo of config). */
    tolerancePaise: z.number().int().optional(),
    /** Engineering-facing reasoning (which matrix rule fired, etc).
     *  Populated for pending_review decisions; reviewer UI hides it but
     *  audit + retraining pipelines read from here. */
    auditReasoning: z.string().optional(),
    /** AI confidence band (high / medium / low) from the disposition agent. */
    confidence: z.enum(['high', 'medium', 'low']).optional(),
    /**
     * Final settlement bucket assigned by the deterministic disposition engine.
     * Populated on the SUMMARY decision the workflow emits per MIS row (one
     * per MIS row, not per leg-match). Drives the report-pack categorisation
     * and the settlement_upload.csv content.
     */
    disposition: DispositionMetadataSchema.optional(),
  })
  .strict();
export type DecisionMetadata = z.infer<typeof DecisionMetadataSchema>;

export const RecoDecisionSchema = z.object({
  sourceTxnId: z.string(),
  targetTxnId: z.string().nullable(),
  matchType: MatchTypeSchema,
  amountDeltaPaise: z.number().int().default(0),
  /** 'system' for deterministic / auto-fuzzy; user id otherwise */
  decidedBy: z.string(),
  /** Customer-readable reasoning. Audited; rendered in UI detail panes. */
  reasoning: z.string().optional(),
  /** Structured details — preferred over parsing `reasoning` strings. */
  metadata: DecisionMetadataSchema.optional(),
  /** Version of the matcher that produced this decision (for replay/audit) */
  matcherVersion: z.string(),
});
export type RecoDecision = z.infer<typeof RecoDecisionSchema>;

// ─── Workflow I/O schemas ────────────────────────────────────────────────────

export const ReconcileInputSchema = z.object({
  /** YYYY-MM-DD — the bank-statement date we're reconciling */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  /** Bank source — controls which fetcher runs */
  source: z.enum(['axis', 'hdfc', 'icici']),
  /** Override the auto-generated run id for replays */
  runId: z.string().optional(),
});
export type ReconcileInput = z.infer<typeof ReconcileInputSchema>;

export const ReconcileOutputSchema = z.object({
  runId: z.string(),
  date: z.string(),
  source: z.string(),
  totals: z.object({
    exact: z.number(),
    fuzzyAuto: z.number(),
    fuzzyHuman: z.number(),
    unmatched: z.number(),
    writtenOff: z.number(),
    flagged: z.number(),
  }),
  /** True if the run was a no-op (already completed previously) */
  skipped: z.boolean().default(false),
});
export type ReconcileOutput = z.infer<typeof ReconcileOutputSchema>;

// ─── Fuzzy match / disposition schemas ───────────────────────────────────────

/** A candidate the fuzzy matcher considers for a single unmatched txn. */
export const FuzzyCandidateSchema = z.object({
  candidateTxnId: z.string(),
  similarityScore: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const FuzzyMatchResultSchema = z.object({
  unmatchedSourceId: z.string(),
  bestCandidate: FuzzyCandidateSchema.nullable(),
  alternatives: z.array(FuzzyCandidateSchema).default([]),
});
export type FuzzyMatchResult = z.infer<typeof FuzzyMatchResultSchema>;

/** Disposition the LLM proposes for each fuzzy result. */
export const DispositionSchema = z.object({
  sourceTxnId: z.string(),
  recommendation: z.enum(['auto_match', 'human_review', 'write_off', 'flag_fraud']),
  targetTxnId: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  /** Internal/audit reasoning — cites the matrix rule and signals. Engineer-
   *  facing; goes into logs and the audit table. */
  reasoning: z.string(),
  /** Reviewer-facing explanation — one short sentence in plain English
   *  describing what the AI saw and what the reviewer should verify.
   *  Surfaced in OpenArc's review UI when recommendation='human_review'.
   *  Empty string acceptable for auto_match / write_off / flag_fraud. */
  reviewerExplanation: z.string(),
});
export type Disposition = z.infer<typeof DispositionSchema>;
