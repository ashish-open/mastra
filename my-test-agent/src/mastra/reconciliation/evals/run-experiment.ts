/**
 * Mastra-native experiment runner for the reco agents.
 *
 * Unlike `run-eval.ts` (which prints to stdout and writes JSON to disk), this
 * uses `Dataset.startExperiment()` so each run appears in Studio → Experiments
 * with per-item scores, deltas vs prior runs, and links back to source items.
 *
 * Run:
 *   pnpm eval:reco:exp                  # both datasets
 *   pnpm eval:reco:exp fuzzy            # just fuzzy
 *   pnpm eval:reco:exp disposition      # just disposition
 *
 * Prereq: the Mastra dev/start server must be reachable so `mastra.datasets`
 * resolves to the same storage backend that Studio is reading. We import
 * `mastra` from `../../index.ts` directly — the import side-effect seeds
 * datasets, so the named datasets always exist by the time we look them up.
 */

import { mastra } from '../../index.js';
import { seedRecoDatasets } from './seed-datasets.js';
import { fuzzyMatchAgent, dispositionAgent } from '../agents.js';
import {
  FuzzyMatchResultSchema,
  DispositionSchema,
  type FuzzyMatchResult,
  type Disposition,
  type NormalizedTxn,
} from '../types.js';
// Scorer IDs (strings) — Mastra 1.35's experiment runner resolves scorers by
// their internal id via mastra.getScorerById(). Passing scorer instances
// stringifies them ("[object Object]") and produces "Scorer with id [ not
// found" errors. The IDs below MUST match the `id` field set in
// createScorer() in scorers.ts.
const CANDIDATE_VALIDITY_SCORER_ID = 'candidate-validity';
const DISPOSITION_ACCURACY_SCORER_ID = 'disposition-accuracy';
const REASONING_QUALITY_SCORER_ID = 'reasoning-quality';
import type { FuzzyEvalCase, DispositionEvalCase } from './dataset.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatRupees(paise: number | undefined | null): string {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return '—';
  const sign = paise < 0 ? '-' : '';
  const rupees = Math.abs(paise) / 100;
  return `${sign}₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function txnForLlm<T extends { amountPaise?: number } | null | undefined>(
  t: T
): T extends null | undefined ? null : T & { displayAmount: string } {
  if (!t) return null as never;
  return { ...t, displayAmount: formatRupees(t.amountPaise ?? 0) } as never;
}

// ─── Fuzzy experiment ───────────────────────────────────────────────────────

async function runFuzzyExperiment(datasetId: string): Promise<void> {
  const dataset = await mastra.datasets.get({ id: datasetId });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const summary = await dataset.startExperiment<FuzzyEvalCase['input'], FuzzyMatchResult, FuzzyEvalCase['expected']>({
    name: `Reco Fuzzy — ${stamp}`,
    description: 'Fuzzy match agent run vs labeled dataset',
    maxConcurrency: 6,
    task: async ({ input }) => {
      const prompt = [
        'Unmatched transaction:',
        JSON.stringify(txnForLlm(input.unmatched), null, 2),
        '',
        'Candidate pool (transactions from OTHER sources):',
        JSON.stringify(input.candidatePool.map(txnForLlm), null, 2),
        '',
        'When writing rupee figures in your reasoning, ALWAYS quote the `displayAmount` field. NEVER cite `amountPaise` directly as a rupee value (it is in paise, where 100 paise = ₹1).',
        '',
        'Pick the best candidate (or null if none plausible).',
      ].join('\n');
      const r = await fuzzyMatchAgent.generate(prompt, {
        structuredOutput: { schema: FuzzyMatchResultSchema },
      });
      return (r as unknown as { object: FuzzyMatchResult }).object;
    },
    scorers: [CANDIDATE_VALIDITY_SCORER_ID, REASONING_QUALITY_SCORER_ID],
  });

  console.log(`[reco] Fuzzy experiment ${summary.experimentId} — ${summary.succeededCount}/${summary.totalItems} ok, ${summary.failedCount} failed`);
}

// ─── Disposition experiment ─────────────────────────────────────────────────

async function runDispositionExperiment(datasetId: string): Promise<void> {
  const dataset = await mastra.datasets.get({ id: datasetId });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const summary = await dataset.startExperiment<DispositionEvalCase['input'], Disposition, DispositionEvalCase['expected']>({
    name: `Reco Disposition — ${stamp}`,
    description: 'Disposition agent run vs labeled dataset',
    maxConcurrency: 6,
    task: async ({ input }) => {
      const today = new Date(input.sourceTxn.date as string);
      const stale = new Date('2026-05-13'); // dataset's reference "today"
      const daysOld = Math.max(0, Math.round((stale.getTime() - today.getTime()) / 86_400_000));
      const prompt = [
        'Unmatched source transaction:',
        JSON.stringify(txnForLlm(input.sourceTxn as NormalizedTxn), null, 2),
        '',
        'Fuzzy match result:',
        JSON.stringify(input.fuzzyResult, null, 2),
        '',
        `daysOld: ${daysOld}`,
        '',
        'Walk the decision matrix top-to-bottom and pick exactly ONE recommendation.',
      ].join('\n');
      const r = await dispositionAgent.generate(prompt, {
        structuredOutput: { schema: DispositionSchema },
      });
      return (r as unknown as { object: Disposition }).object;
    },
    scorers: [DISPOSITION_ACCURACY_SCORER_ID, REASONING_QUALITY_SCORER_ID],
  });

  console.log(`[reco] Disposition experiment ${summary.experimentId} — ${summary.succeededCount}/${summary.totalItems} ok, ${summary.failedCount} failed`);
}

// ─── CLI entry ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Await seeding (idempotent — returns existing IDs if already seeded).
  // We use the IDs from the seed report directly rather than re-querying via
  // mastra.datasets.list — that was returning empty even after a successful
  // create, likely a read-after-write visibility quirk in the LibSQL adapter
  // when called immediately after the writing call.
  const report = await seedRecoDatasets(mastra);

  const which = process.argv[2];
  if (!which || which === 'fuzzy') await runFuzzyExperiment(report.fuzzy.datasetId);
  if (!which || which === 'disposition') await runDispositionExperiment(report.disposition.datasetId);
  // Datasets persist in storage; nothing else to flush.
  process.exit(0);
}

main().catch(err => {
  console.error('[reco] run-experiment failed:', err);
  process.exit(1);
});
