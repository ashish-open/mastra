/**
 * Canonical schemas for the statement-reconciliation pipeline.
 *
 * All three sources (internal ledger, PG settlements, bank statement) get
 * normalized into NormalizedTxn so downstream matchers don't care where the
 * data came from.
 */

import { z } from 'zod';

// ─── Canonical normalized transaction ────────────────────────────────────────

export const NormalizedTxnSchema = z.object({
  /** Source-specific original ID */
  sourceId: z.string(),
  /** Which system this came from */
  source: z.enum(['internal', 'pg', 'bank']),
  /** Amount in paise (always integer — never use floats for money) */
  amountPaise: z.number().int(),
  /** ISO date (yyyy-mm-dd) the txn occurred in the source's books */
  date: z.string(),
  /** Bank UTR / RRN — populated when known. Bank-credit rows always have it; internal rows may not. */
  utr: z.string().nullable().optional(),
  /** Merchant-side reference IDs we set when initiating */
  merchantRefId: z.string().nullable().optional(),
  /** PG-side settlement batch ID (groups payments into one bank credit) */
  settlementId: z.string().nullable().optional(),
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
export const DecisionMetadataSchema = z
  .object({
    /** Strategy name from ReconcileConfig.matches[].name (e.g. 'razorpay_batch_to_bank'). */
    strategyName: z.string().optional(),
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
