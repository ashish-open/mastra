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
  'exact',          // deterministic match — UTR or merchant_ref equal
  'fuzzy_auto',     // LLM suggested with high confidence, auto-accepted
  'fuzzy_human',    // LLM suggested, human approved
  'pending_review', // system queued for human reviewer (suspend/resume target)
  'unmatched',      // truly no candidate found AND no fraud signals AND not eligible for write-off
  'written_off',    // small + old: auto-resolved as not worth chasing
  'flagged_fraud',  // active fraud signals detected
]);
export type MatchType = z.infer<typeof MatchTypeSchema>;

export const RecoDecisionSchema = z.object({
  sourceTxnId: z.string(),
  targetTxnId: z.string().nullable(),
  matchType: MatchTypeSchema,
  amountDeltaPaise: z.number().int().default(0),
  /** 'system' for deterministic / auto-fuzzy; user id otherwise */
  decidedBy: z.string(),
  /** LLM reasoning when fuzzy; empty for exact */
  reasoning: z.string().optional(),
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
  reasoning: z.string(),
});
export type Disposition = z.infer<typeof DispositionSchema>;
