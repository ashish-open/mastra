/**
 * Scorers for the Knowledge Bot retrieval eval.
 *
 *   1. retrievalRecallScorer — did `searchKnowledge` return at least one of
 *      the expected source filenames in the top-K results? Binary 0/1.
 *      Substring match (case-insensitive) so the dataset can use just the
 *      filename and not the full path.
 *
 * Future:
 *   - retrievalPrecisionScorer  — fraction of top-K results that are
 *                                 considered relevant (needs richer labels).
 *   - answerFaithfulnessScorer  — LLM-judged: does the agent's answer cite
 *                                 facts that actually appear in the
 *                                 retrieved chunks?
 */

import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';

const RetrievalInput = z.object({
  question: z.string(),
}).passthrough();

const RetrievalOutput = z.object({
  /** Source filenames returned by the searchKnowledge tool, in rank order. */
  retrievedSources: z.array(z.string()),
});

interface RetrievalGroundTruth {
  expectedSources: string[];
}

export const retrievalRecallScorer = createScorer({
  id: 'knowledge-retrieval-recall',
  name: 'Knowledge Retrieval Recall',
  description:
    'Verifies the searchKnowledge tool returned at least one of the expected ' +
    'source documents in the top-K results. Binary 0/1.',
  type: {
    input: RetrievalInput,
    output: RetrievalOutput,
  },
}).generateScore(({ run }) => {
  const gt = run.groundTruth as RetrievalGroundTruth | undefined;
  const expected = gt?.expectedSources ?? [];
  // Empty-expected = negative-test: pass if we returned ZERO results (the
  // agent has no business citing anything for this question).
  if (expected.length === 0) return run.output.retrievedSources.length === 0 ? 1 : 0;

  const retrieved = run.output.retrievedSources.map(s => s.toLowerCase());
  const hit = expected.some(exp => {
    const e = exp.toLowerCase();
    return retrieved.some(r => r.includes(e) || e.includes(r));
  });
  return hit ? 1 : 0;
});
