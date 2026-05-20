/**
 * Run a Mastra-native experiment for the support-triage classifier.
 *
 *   pnpm eval:triage:exp
 *
 * Each run lands in Studio → Datasets → Support Triage Classification v1 →
 * Experiments. Re-run after any prompt or taxonomy change to spot regressions.
 */

import { z } from 'zod';
import { mastra } from '../index.js';
import { seedSupportTriageDataset } from './seed-datasets.js';
import { supportClassifierAgent } from './classifier-agent.js';
import { SUPPORT_CATEGORIES, type SupportCategory, type SupportEvalCase } from './dataset.js';

const ClassifierOutputSchema = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
});

type ClassifierInput = Pick<SupportEvalCase, 'subject' | 'body'>;
type ClassifierOutput = { category: SupportCategory };
type ClassifierGroundTruth = { expectedCategory: SupportCategory };

async function main(): Promise<void> {
  const report = await seedSupportTriageDataset(mastra);
  const dataset = await mastra.datasets.get({ id: report.datasetId });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const summary = await dataset.startExperiment<ClassifierInput, ClassifierOutput, ClassifierGroundTruth>({
    name: `Support Triage Classification — ${stamp}`,
    description: 'Slim classifier run vs labeled synthetic dataset',
    maxConcurrency: 6,
    task: async ({ input }) => {
      const prompt = `Subject: ${input.subject}\n\nBody:\n${input.body}\n\nReturn the category.`;
      const r = await supportClassifierAgent.generate(prompt, {
        structuredOutput: { schema: ClassifierOutputSchema },
      });
      return (r as unknown as { object: ClassifierOutput }).object;
    },
    scorers: ['support-category-accuracy'],
  });

  console.log(
    `[triage] Classification experiment ${summary.experimentId} — ` +
    `${summary.succeededCount}/${summary.totalItems} ok, ${summary.failedCount} failed`
  );
  process.exit(0);
}

main().catch(err => {
  console.error('[triage] run-experiment failed:', err);
  process.exit(1);
});
