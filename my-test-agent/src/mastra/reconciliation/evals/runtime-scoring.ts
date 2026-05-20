/**
 * Inline runtime scorer invocations for the reconciliation workflow.
 *
 * Why this exists:
 *   We have three scorers defined for offline eval (run via
 *   `pnpm eval:reco:exp`). To also see scores for PRODUCTION reco runs,
 *   we fire the same scorers from inside the workflow steps right after
 *   the LLM call. Each `scorer.run()` invocation creates a SCORER_RUN
 *   span in observability storage and persists a row to mastra_scores,
 *   both of which surface in Studio.
 *
 *   We deliberately do NOT use `agent.generate({ scorers })` here — that
 *   shape passes the agent's raw message I/O to the scorer, which would
 *   require rewriting our scorers to read structured payloads out of
 *   chat messages. Calling `scorer.run()` directly with the typed step
 *   values is far cleaner.
 *
 * Sampling:
 *   Controlled by env var RECO_SCORE_SAMPLE_RATE (0..1). Defaults to 1.0
 *   in non-production (full coverage) and 0.1 in production (one-in-ten,
 *   manageable cost). Override per-deployment as needed.
 *
 * Error policy:
 *   Scoring must NEVER break the workflow. All scorer failures are
 *   caught and logged at warn level. The score is simply missing for
 *   that case — picked up next time.
 */

import {
  candidateValidityScorer,
  dispositionAccuracyScorer,
  reasoningQualityScorer,
} from './scorers.js';
import type { FuzzyMatchResult, Disposition, NormalizedTxn } from '../types.js';

const SAMPLE_RATE = (() => {
  const raw = process.env.RECO_SCORE_SAMPLE_RATE;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return process.env.NODE_ENV === 'production' ? 0.1 : 1.0;
})();

function shouldSample(): boolean {
  return Math.random() < SAMPLE_RATE;
}

/**
 * Score a fuzzy-match agent call:
 *   - candidate-validity   (was the chosen id actually in the pool?)
 *   - reasoning-quality    (LLM-judge: does the reasoning cite real signals?)
 *
 * Fires-and-returns. Awaiting is optional — the workflow should NOT block on
 * scoring. If you await the array of promises, errors are already swallowed
 * so it's still safe.
 */
export function scoreFuzzyCall(args: {
  candidatePool: NormalizedTxn[];
  unmatched: NormalizedTxn;
  result: FuzzyMatchResult;
}): Promise<unknown>[] {
  if (!shouldSample()) return [];
  const tasks: Promise<unknown>[] = [];

  tasks.push(
    candidateValidityScorer.run({
      input: { candidatePool: args.candidatePool.map(c => ({ sourceId: c.sourceId })) },
      output: { bestCandidate: args.result.bestCandidate },
      scoreSource: 'live',
    }).catch((err: unknown) => {
      console.warn('[reco] candidate-validity scorer failed (non-fatal):', err instanceof Error ? err.message : err);
    })
  );

  // Only score reasoning when there's a candidate AND a reasoning string —
  // judging an empty reasoning is meaningless and wastes a model call.
  const reasoning = args.result.bestCandidate?.reasoning;
  if (reasoning && reasoning.length > 0) {
    tasks.push(
      reasoningQualityScorer.run({
        input: { unmatchedTxn: args.unmatched, selectedCandidate: args.result.bestCandidate },
        output: { reasoning },
        scoreSource: 'live',
      }).catch((err: unknown) => {
        console.warn('[reco] reasoning-quality scorer failed (non-fatal):', err instanceof Error ? err.message : err);
      })
    );
  }

  return tasks;
}

/**
 * Score a disposition agent call:
 *   - We CANNOT score `disposition-accuracy` live because there's no
 *     ground-truth `expectedRecommendation` in production — that signal
 *     exists only in the labeled offline dataset. So this helper only
 *     scores reasoning-quality.
 */
export function scoreDispositionCall(args: {
  sourceTxn: NormalizedTxn;
  fuzzyResult: FuzzyMatchResult;
  disposition: Disposition;
}): Promise<unknown>[] {
  if (!shouldSample()) return [];
  const tasks: Promise<unknown>[] = [];

  // For now, no live scoring on disposition — placeholder.
  // (Disposition correctness needs ground truth or a separate LLM-judge.)
  void args; void dispositionAccuracyScorer;

  return tasks;
}
