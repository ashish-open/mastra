/**
 * Three scorers for the reconciliation agents.
 *
 *   1. candidateValidityScorer   — did fuzzyMatchAgent pick a candidate ID
 *                                  that actually exists in the input pool?
 *                                  Catches the most insidious hallucination
 *                                  (invented IDs). Code-only, no LLM.
 *
 *   2. dispositionAccuracyScorer — did dispositionAgent pick the same
 *                                  recommendation as the labeled expected?
 *                                  Code-only, no LLM.
 *
 *   3. reasoningQualityScorer    — LLM-as-judge: does the agent's reasoning
 *                                  reference REAL signals (amount delta,
 *                                  counterparty similarity, UTR/refId match)
 *                                  rather than generic phrases? Returns 0/0.5/1.
 *
 * All three follow Mastra's createScorer API. They're registered in
 * index.ts so they appear in Studio → Scorers.
 */

import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const CandidateValidityInput = z.object({
  candidatePool: z.array(z.object({ sourceId: z.string() })),
});
const CandidateValidityOutput = z.object({
  bestCandidate: z.object({ candidateTxnId: z.string() }).nullable(),
});

const DispositionInput = z.object({
  expectedRecommendation: z.enum(['auto_match', 'human_review', 'write_off', 'flag_fraud']),
});
const DispositionOutput = z.object({
  recommendation: z.enum(['auto_match', 'human_review', 'write_off', 'flag_fraud']),
  reasoning: z.string().optional(),
});

const ReasoningInput = z.object({
  unmatchedTxn: z.unknown(),
  selectedCandidate: z.unknown().nullable(),
});
const ReasoningOutput = z.object({
  reasoning: z.string(),
});

// ─── 1. Candidate validity ───────────────────────────────────────────────────

export const candidateValidityScorer = createScorer({
  id: 'candidate-validity',
  name: 'Candidate Validity',
  description:
    "Verifies the fuzzy matcher's chosen candidate ID exists in the candidate pool. A score of 0 means the agent hallucinated an ID.",
  type: {
    input: CandidateValidityInput,
    output: CandidateValidityOutput,
  },
}).generateScore(({ run }) => {
  const out = run.output;
  if (!out.bestCandidate) return 1; // null is a legitimate choice
  const pool = run.input?.candidatePool ?? [];
  return pool.some(p => p.sourceId === out.bestCandidate!.candidateTxnId) ? 1 : 0;
});

// ─── 2. Disposition accuracy ─────────────────────────────────────────────────

export const dispositionAccuracyScorer = createScorer({
  id: 'disposition-accuracy',
  name: 'Disposition Accuracy',
  description:
    'Compares the disposition agent recommendation against the labeled expected recommendation. Binary 0/1.',
  type: {
    input: DispositionInput,
    output: DispositionOutput,
  },
}).generateScore(({ run }) => {
  return run.output.recommendation === run.input?.expectedRecommendation ? 1 : 0;
});

// ─── 3. Reasoning quality (LLM-judged) ───────────────────────────────────────

export const reasoningQualityScorer = createScorer({
  id: 'reasoning-quality',
  name: 'Reasoning Quality',
  description:
    'Grades whether the agent reasoning references concrete signals (amount delta, counterparty match, UTR/refId overlap) rather than generic phrases. Returns 0, 0.5, or 1.',
  type: {
    input: ReasoningInput,
    output: ReasoningOutput,
  },
}).generateScore({
  description: 'LLM-judge grades reasoning grounding 0..1',
  judge: {
    model: 'openai/gpt-4o-mini',
    instructions: `
You are grading the quality of a payment-reconciliation agent's reasoning.

Score 1.0 — reasoning cites SPECIFIC signals: exact amount delta in
            paise/rupees, named counterparty similarity, specific field
            overlap (refId, UTR), date proximity in days.
Score 0.5 — partly grounded but uses some generic phrases without numbers.
Score 0.0 — entirely generic OR cites signals that contradict the input
            OR references fields/values that don't appear in the input.

Output ONLY the score as a JSON number on a single line: 1.0, 0.5, or 0.0.
No prose. No object. Just the number.
`.trim(),
  },
  createPrompt: ({ run }) => `
Input to the agent:
${JSON.stringify(run.input, null, 2)}

Agent's reasoning:
"${run.output.reasoning}"

Grade the reasoning. Output ONLY one of: 1.0, 0.5, 0.0
`.trim(),
});
