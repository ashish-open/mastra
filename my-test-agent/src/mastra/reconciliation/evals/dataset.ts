/**
 * Labeled eval dataset for the reconciliation agents.
 *
 * Each case captures a realistic edge case + the expected agent behavior.
 * The dataset has two halves:
 *   - FUZZY_CASES        — input for fuzzyMatchAgent (unmatched txn + candidates),
 *                          expected bestCandidate
 *   - DISPOSITION_CASES  — input for dispositionAgent (a fuzzy result),
 *                          expected recommendation
 *
 * To add new cases: copy a row, change the inputs, set the expected output.
 * Aim for coverage across categories listed in CATEGORIES below.
 */

import type { NormalizedTxn, FuzzyMatchResult, Disposition } from '../types.js';

export const CATEGORIES = [
  'exact_match',         // amount + ref + counterparty all align (sanity)
  'amount_rounding',     // small ₹1-50 delta (rounding/charge deduction)
  'counterparty_alias',  // "Acme Corp" vs "Acme Corp Pvt Ltd"
  'commission_deduct',   // gross vs net (Swiggy 22% commission)
  'refund_chain',        // negative amount, refund-shaped
  'orphan_no_candidate', // no plausible match anywhere
  'ambiguous_dup',       // multiple identical candidates
  'fraud_pattern',       // round numbers, unknown counterparty
  'small_old_writeoff',  // tiny amount, very old
  'wrong_utr_typo',      // UTR typo, amount+counterparty match
] as const;
export type Category = typeof CATEGORIES[number];

// ─── Fuzzy matcher dataset ───────────────────────────────────────────────────
//
// Each case is one unmatched transaction + a candidate pool. The agent must
// pick the bestCandidate (or null). We grade on:
//   1. Did it pick a valid candidate (id exists in pool)?
//   2. Did it pick the right one (matches expectedCandidateId, or null when
//      expectedCandidateId is null)?
//   3. Is the reasoning grounded in real signals?

export interface FuzzyEvalCase {
  name: string;
  category: Category;
  notes?: string;
  input: {
    unmatched: NormalizedTxn;
    candidatePool: NormalizedTxn[];
  };
  expected: {
    /** null = no candidate should be selected */
    candidateTxnId: string | null;
    /** Acceptable similarity-score range */
    minScore?: number;
    maxScore?: number;
  };
}

const baseDate = '2026-05-13';

export const FUZZY_CASES: FuzzyEvalCase[] = [
  // ─── exact_match ───────────────────────────────────────────────────────────
  {
    name: 'pristine refId + amount match',
    category: 'exact_match',
    input: {
      unmatched: { sourceId: 'int_001', source: 'internal', date: baseDate, amountPaise: 500_00, merchantRefId: 'ord_acme_1', description: 'Acme Q1 invoice', counterparty: 'Acme Corp' },
      candidatePool: [
        { sourceId: 'pg_a01', source: 'pg', date: baseDate, amountPaise: 500_00, merchantRefId: 'ord_acme_1', counterparty: 'Acme Corp', utr: 'AXISN001' },
        { sourceId: 'pg_a02', source: 'pg', date: baseDate, amountPaise: 9999_00, merchantRefId: 'ord_xyz', counterparty: 'Other Co', utr: 'AXISN002' },
      ],
    },
    expected: { candidateTxnId: 'pg_a01', minScore: 0.9 },
  },

  // ─── amount_rounding ───────────────────────────────────────────────────────
  {
    name: '₹0.50 rounding delta',
    category: 'amount_rounding',
    notes: 'Real PGs often round; should still match with high confidence.',
    input: {
      unmatched: { sourceId: 'int_002', source: 'internal', date: baseDate, amountPaise: 3_200_00, merchantRefId: 'ord_mock_1', description: 'Mock Industries' },
      candidatePool: [
        { sourceId: 'pg_b01', source: 'pg', date: baseDate, amountPaise: 3_200_50, merchantRefId: 'ord_mock_1', counterparty: 'Mock Industries Pvt Ltd' },
        { sourceId: 'pg_b02', source: 'pg', date: baseDate, amountPaise: 5_000_00, merchantRefId: 'ord_other' },
      ],
    },
    expected: { candidateTxnId: 'pg_b01', minScore: 0.85 },
  },
  {
    name: '₹25 charge deduction (likely processing fee)',
    category: 'amount_rounding',
    input: {
      unmatched: { sourceId: 'int_003', source: 'internal', date: baseDate, amountPaise: 10_000_00, merchantRefId: 'ord_x', counterparty: 'Customer X' },
      candidatePool: [
        { sourceId: 'pg_c01', source: 'pg', date: baseDate, amountPaise: 9_975_00, merchantRefId: 'ord_x', counterparty: 'Customer X' },
      ],
    },
    expected: { candidateTxnId: 'pg_c01', minScore: 0.7 },
  },

  // ─── counterparty_alias ────────────────────────────────────────────────────
  {
    name: 'Pvt Ltd suffix variation',
    category: 'counterparty_alias',
    input: {
      unmatched: { sourceId: 'int_004', source: 'internal', date: baseDate, amountPaise: 7_500_00, merchantRefId: 'ord_acme_2', counterparty: 'Acme' },
      candidatePool: [
        { sourceId: 'pg_d01', source: 'pg', date: baseDate, amountPaise: 7_500_00, merchantRefId: 'ord_acme_2', counterparty: 'Acme Corporation Pvt Ltd' },
      ],
    },
    expected: { candidateTxnId: 'pg_d01', minScore: 0.85 },
  },
  {
    name: 'misspelled counterparty (suspicious typo)',
    category: 'counterparty_alias',
    notes: 'Acne vs Acme — looks like a typo BUT could be a different entity. Lower confidence.',
    input: {
      unmatched: { sourceId: 'int_005', source: 'internal', date: baseDate, amountPaise: 1_200_00, merchantRefId: null, counterparty: 'Acme Corp' },
      candidatePool: [
        { sourceId: 'pg_e01', source: 'pg', date: baseDate, amountPaise: 1_200_00, merchantRefId: null, counterparty: 'Acne Co' },
        { sourceId: 'pg_e02', source: 'pg', date: baseDate, amountPaise: 9_000_00, merchantRefId: 'ord_y', counterparty: 'Other' },
      ],
    },
    expected: { candidateTxnId: 'pg_e01', minScore: 0.5, maxScore: 0.75 },
  },

  // ─── commission_deduct ─────────────────────────────────────────────────────
  {
    name: 'Swiggy 22% commission deduction',
    category: 'commission_deduct',
    notes: 'POS=500, expected Swiggy net = 500 - 110 - 19.8 - 5 = 365.2. Agent should still match.',
    input: {
      unmatched: { sourceId: 'pos_SW-2026-001', source: 'internal', date: baseDate, amountPaise: 500_00, merchantRefId: 'SW-2026-001', counterparty: 'Restaurant POS', description: 'POS order SW-2026-001' },
      candidatePool: [
        { sourceId: 'swiggy_SW-2026-001', source: 'pg', date: baseDate, amountPaise: 365_20, merchantRefId: 'SW-2026-001', counterparty: 'Swiggy', description: 'Swiggy net payout' },
      ],
    },
    expected: { candidateTxnId: 'swiggy_SW-2026-001', minScore: 0.85 },
  },

  // ─── refund_chain ──────────────────────────────────────────────────────────
  {
    name: 'refund — negative bank entry',
    category: 'refund_chain',
    notes: 'Should match but flag as refund-shaped.',
    input: {
      unmatched: { sourceId: 'int_006', source: 'internal', date: baseDate, amountPaise: -2_500_00, merchantRefId: 'ord_refund_1', description: 'Refund for cancelled order', counterparty: 'Customer Y' },
      candidatePool: [
        { sourceId: 'pg_f01', source: 'pg', date: baseDate, amountPaise: -2_500_00, merchantRefId: 'ord_refund_1', counterparty: 'Customer Y', description: 'Refund processed' },
      ],
    },
    expected: { candidateTxnId: 'pg_f01', minScore: 0.85 },
  },

  // ─── orphan_no_candidate ───────────────────────────────────────────────────
  {
    name: 'orphan internal txn — no PG counterpart',
    category: 'orphan_no_candidate',
    input: {
      unmatched: { sourceId: 'int_007', source: 'internal', date: baseDate, amountPaise: 2_100_00, merchantRefId: 'ord_orph_1', description: 'Orphan payment (paid via cheque)' },
      candidatePool: [
        { sourceId: 'pg_g01', source: 'pg', date: baseDate, amountPaise: 5_000_00, merchantRefId: 'ord_other', counterparty: 'Different Co' },
        { sourceId: 'bank_g01', source: 'bank', date: baseDate, amountPaise: 50_000_00, utr: 'XYZ123', counterparty: 'Unrelated' },
      ],
    },
    expected: { candidateTxnId: null },
  },
  {
    name: 'bank credit without source',
    category: 'orphan_no_candidate',
    notes: 'Direct customer wire — no PG record.',
    input: {
      unmatched: { sourceId: 'bank_002', source: 'bank', date: baseDate, amountPaise: 50_000_00, utr: 'HDFC999', counterparty: 'Direct Customer', description: 'NEFT credit from customer wire' },
      candidatePool: [
        { sourceId: 'pg_h01', source: 'pg', date: baseDate, amountPaise: 500_00, merchantRefId: 'ord_xyz' },
        { sourceId: 'int_h01', source: 'internal', date: baseDate, amountPaise: 750_00 },
      ],
    },
    expected: { candidateTxnId: null },
  },

  // ─── ambiguous_dup ─────────────────────────────────────────────────────────
  {
    name: 'two identical candidates — same amount, same day',
    category: 'ambiguous_dup',
    notes: 'Either pick the one with refId match, or score both low.',
    input: {
      unmatched: { sourceId: 'int_008', source: 'internal', date: baseDate, amountPaise: 1_000_00, merchantRefId: 'ord_abc', counterparty: 'Customer Z' },
      candidatePool: [
        { sourceId: 'pg_i01', source: 'pg', date: baseDate, amountPaise: 1_000_00, merchantRefId: 'ord_abc', counterparty: 'Customer Z' },
        { sourceId: 'pg_i02', source: 'pg', date: baseDate, amountPaise: 1_000_00, merchantRefId: 'ord_def', counterparty: 'Customer Z' },
      ],
    },
    expected: { candidateTxnId: 'pg_i01', minScore: 0.85 },
  },

  // ─── fraud_pattern ─────────────────────────────────────────────────────────
  {
    name: 'unknown counterparty, suspicious round number',
    category: 'fraud_pattern',
    notes: 'Should NOT confidently match. Score low or pick null.',
    input: {
      unmatched: { sourceId: 'bank_003', source: 'bank', date: baseDate, amountPaise: 1_00_000_00, utr: 'XXX000000', counterparty: 'UNKNOWN', description: 'NEFT' },
      candidatePool: [
        { sourceId: 'pg_j01', source: 'pg', date: baseDate, amountPaise: 500_00, merchantRefId: 'ord_z' },
        { sourceId: 'int_j01', source: 'internal', date: baseDate, amountPaise: 750_00 },
      ],
    },
    expected: { candidateTxnId: null, maxScore: 0.3 },
  },
];

// ─── Disposition agent dataset ───────────────────────────────────────────────
//
// Each case is a FuzzyMatchResult + the original source txn + expected
// recommendation. The disposition agent receives BOTH the fuzzy result AND
// the source txn — fraud signals (round amount, UNKNOWN counterparty, odd
// UTR) are on the source txn, not in the fuzzy result.

export interface DispositionEvalCase {
  name: string;
  category: Category;
  notes?: string;
  input: {
    fuzzyResult: FuzzyMatchResult;
    /** The original unmatched txn — for fraud-signal inspection. */
    sourceTxn: NormalizedTxn;
  };
  expected: {
    recommendation: Disposition['recommendation'];
    confidence?: Disposition['confidence'];
  };
}

// Dates: "today" is 2026-05-13 for the dataset; "60 days ago" is 2026-03-14
const today = baseDate;
const sixtyDaysAgo = '2026-03-14';

export const DISPOSITION_CASES: DispositionEvalCase[] = [
  {
    name: 'high-confidence fuzzy → auto_match',
    category: 'exact_match',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'int_001',
        bestCandidate: { candidateTxnId: 'pg_a01', similarityScore: 0.97, reasoning: 'amount delta 0, refId identical, counterparty identical' },
        alternatives: [],
      },
      sourceTxn: { sourceId: 'int_001', source: 'internal', date: today, amountPaise: 500_00, merchantRefId: 'ord_acme_1', counterparty: 'Acme Corp', description: 'Acme Q1 invoice' },
    },
    expected: { recommendation: 'auto_match', confidence: 'high' },
  },
  {
    name: 'medium confidence (rounding) → human_review',
    category: 'amount_rounding',
    notes: 'Real PGs may round, but disposition is conservative.',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'int_002',
        bestCandidate: { candidateTxnId: 'pg_b01', similarityScore: 0.88, reasoning: '₹0.50 delta likely rounding; refId identical; counterparty matches' },
        alternatives: [],
      },
      sourceTxn: { sourceId: 'int_002', source: 'internal', date: today, amountPaise: 3_200_00, merchantRefId: 'ord_mock_1', counterparty: 'Mock Industries' },
    },
    expected: { recommendation: 'human_review' },
  },
  {
    name: 'no candidate found, large amount, named counterparty → human_review',
    category: 'orphan_no_candidate',
    notes: 'Direct customer wire — named counterparty, plausible business amount, plausible UTR. NOT fraud.',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'bank_002',
        bestCandidate: null,
        alternatives: [],
      },
      sourceTxn: { sourceId: 'bank_002', source: 'bank', date: today, amountPaise: 50_000_00, utr: 'HDFC20260513999', counterparty: 'Direct Customer', description: 'NEFT credit from customer wire' },
    },
    expected: { recommendation: 'human_review' },
  },
  {
    name: 'no candidate + small amount + clearly >30 days old → write_off',
    category: 'small_old_writeoff',
    notes: 'Date 2026-03-14 vs today 2026-05-13 is 60 days. Amount ₹250 < ₹1000.',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'int_tiny_old',
        bestCandidate: null,
        alternatives: [],
      },
      sourceTxn: { sourceId: 'int_tiny_old', source: 'internal', date: sixtyDaysAgo, amountPaise: 250_00, merchantRefId: null, counterparty: 'Tiny Vendor', description: 'Small fee adjustment' },
    },
    expected: { recommendation: 'write_off' },
  },
  {
    name: 'round number, unknown counterparty, odd UTR → flag_fraud',
    category: 'fraud_pattern',
    notes: 'TWO active fraud signals: round ₹1,00,000 + UNKNOWN counterparty + UTR of all zeros.',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'bank_003',
        bestCandidate: null,
        alternatives: [],
      },
      sourceTxn: { sourceId: 'bank_003', source: 'bank', date: today, amountPaise: 1_00_000_00, utr: 'XXX000000', counterparty: 'UNKNOWN', description: 'NEFT' },
    },
    expected: { recommendation: 'flag_fraud' },
  },
  {
    name: 'refund-shaped → human_review (always)',
    category: 'refund_chain',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'int_refund_1',
        bestCandidate: { candidateTxnId: 'pg_f01', similarityScore: 0.92, reasoning: 'negative amount matches, refId identical' },
        alternatives: [],
      },
      sourceTxn: { sourceId: 'int_refund_1', source: 'internal', date: today, amountPaise: -2_500_00, merchantRefId: 'ord_refund_1', counterparty: 'Customer Y', description: 'Refund for cancelled order' },
    },
    expected: { recommendation: 'human_review' },
  },
  {
    name: 'commission-deducted (Swiggy net) → auto_match if high confidence',
    category: 'commission_deduct',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'pos_SW-2026-001',
        bestCandidate: { candidateTxnId: 'swiggy_SW-2026-001', similarityScore: 0.96, reasoning: 'amount matches expected net after 22% commission + GST + 1% TCS; refId identical' },
        alternatives: [],
      },
      sourceTxn: { sourceId: 'pos_SW-2026-001', source: 'internal', date: today, amountPaise: 500_00, merchantRefId: 'SW-2026-001', counterparty: 'Restaurant POS' },
    },
    expected: { recommendation: 'auto_match', confidence: 'high' },
  },
  {
    name: 'ambiguous (similar score) → human_review',
    category: 'ambiguous_dup',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'int_008',
        bestCandidate: { candidateTxnId: 'pg_i01', similarityScore: 0.78, reasoning: 'refId matches but counterparty is generic; alternative pg_i02 has same amount' },
        alternatives: [{ candidateTxnId: 'pg_i02', similarityScore: 0.72, reasoning: 'same amount, same day, different refId' }],
      },
      sourceTxn: { sourceId: 'int_008', source: 'internal', date: today, amountPaise: 1_000_00, merchantRefId: 'ord_abc', counterparty: 'Customer Z' },
    },
    expected: { recommendation: 'human_review' },
  },
  {
    name: 'wrong UTR typo, otherwise solid match → human_review',
    category: 'wrong_utr_typo',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'int_009',
        bestCandidate: { candidateTxnId: 'pg_k01', similarityScore: 0.82, reasoning: 'amount + counterparty match; UTR is one char off (AXISN0100 vs AXISN0010 — likely typo)' },
        alternatives: [],
      },
      sourceTxn: { sourceId: 'int_009', source: 'internal', date: today, amountPaise: 7_500_00, utr: 'AXISN0100', counterparty: 'Acme Corp' },
    },
    expected: { recommendation: 'human_review' },
  },
  {
    name: 'low score, no plausible match → human_review',
    category: 'orphan_no_candidate',
    input: {
      fuzzyResult: {
        unmatchedSourceId: 'int_orph_2',
        bestCandidate: { candidateTxnId: 'pg_x', similarityScore: 0.42, reasoning: 'weak amount match, different counterparty, different day' },
        alternatives: [],
      },
      sourceTxn: { sourceId: 'int_orph_2', source: 'internal', date: today, amountPaise: 3_500_00, merchantRefId: 'ord_z', counterparty: 'Some Vendor' },
    },
    expected: { recommendation: 'human_review' },
  },
];
