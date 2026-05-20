/**
 * Scorers for the Meeting Summarizer action-item extraction eval.
 *
 *   actionItemRecallScorer — fraction of labeled action items that the
 *                            extractor recovered. Returns 0..1.
 *
 *   Matching policy:
 *     - Owner: case-insensitive substring match (first name vs first name).
 *     - Task: LLM-judged for semantic equivalence — the extractor doesn't
 *       have to use the same words, just describe the same commitment.
 *
 * Future:
 *   - actionItemPrecisionScorer — penalize spurious action items not in
 *                                  the labeled set (false positives).
 */

import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';

const ExtractorInput = z.object({
  transcript: z.string(),
}).passthrough();

const ExtractorOutput = z.object({
  actionItems: z.array(z.object({
    owner: z.string(),
    task: z.string(),
  })),
});

interface ExtractorGroundTruth {
  expectedActionItems: Array<{ owner: string; task: string }>;
}

/**
 * Heuristic-only recall: counts how many expected (owner, task) pairs
 * appear in the extracted output. Owner is substring-compared; task uses
 * simple token-overlap so prompt regressions show up immediately. The
 * LLM-judged variant is a follow-up.
 */
export const actionItemRecallScorer = createScorer({
  id: 'meeting-action-item-recall',
  name: 'Meeting Action Item Recall',
  description:
    'Fraction of labeled action items that the extractor recovered. 0..1.',
  type: {
    input: ExtractorInput,
    output: ExtractorOutput,
  },
}).generateScore(({ run }) => {
  const gt = run.groundTruth as ExtractorGroundTruth | undefined;
  const expected = gt?.expectedActionItems ?? [];
  const extracted = run.output.actionItems;

  if (expected.length === 0) {
    // Negative test: full credit only if extractor also returned nothing.
    return extracted.length === 0 ? 1 : 0;
  }

  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

  let matched = 0;
  for (const exp of expected) {
    const expOwner = exp.owner.toLowerCase();
    const expTokens = new Set(norm(exp.task));
    const hit = extracted.find(act => {
      const ownerOk = act.owner.toLowerCase().includes(expOwner) ||
                      expOwner.includes(act.owner.toLowerCase());
      if (!ownerOk) return false;
      const actTokens = norm(act.task);
      // At least 30% of expected task tokens (excluding stopwords) appear in
      // the extracted task — generous enough for paraphrasing, strict enough
      // to catch outright miss.
      const STOP = new Set(['the','a','an','and','or','to','of','for','in','on','by','with','will']);
      const meaningful = [...expTokens].filter(t => !STOP.has(t));
      if (meaningful.length === 0) return true;
      const overlap = meaningful.filter(t => actTokens.includes(t)).length;
      return overlap / meaningful.length >= 0.3;
    });
    if (hit) matched += 1;
  }

  return matched / expected.length;
});
