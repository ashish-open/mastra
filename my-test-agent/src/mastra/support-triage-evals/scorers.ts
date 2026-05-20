/**
 * Scorers for the support-triage classification eval.
 *
 *   1. categoryAccuracyScorer — binary 0/1, did the classifier pick the same
 *      category as the labeled expectedCategory? Code-only, no LLM.
 *
 * Future scorers (not yet implemented):
 *   - routingPrecisionScorer  — when the agent suggests a re-route, is the
 *                               suggested team in the canonical list?
 *   - sourceGroundingScorer   — when the agent cites sources in a draft, do
 *                               they appear in the search-knowledge results?
 *
 * Registered in `src/mastra/index.ts` so it appears in Studio → Scorers.
 */

import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';
import { SUPPORT_CATEGORIES, type SupportCategory } from './dataset.js';

const CategoryInput = z.object({
  subject: z.string(),
  body: z.string(),
});

const CategoryOutput = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
});

interface CategoryGroundTruth {
  expectedCategory: SupportCategory;
}

export const categoryAccuracyScorer = createScorer({
  id: 'support-category-accuracy',
  name: 'Support Category Accuracy',
  description:
    'Compares the classifier\'s chosen category against the labeled expected category. Binary 0/1.',
  type: {
    input: CategoryInput,
    output: CategoryOutput,
  },
}).generateScore(({ run }) => {
  // groundTruth lives on the dataset item separately from input. The Mastra
  // scorer type config only has input/output slots — groundTruth is typed
  // `any` and we cast at the read site.
  const gt = run.groundTruth as CategoryGroundTruth | undefined;
  return run.output.category === gt?.expectedCategory ? 1 : 0;
});
