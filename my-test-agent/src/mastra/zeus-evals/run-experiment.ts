/**
 * Run the Zeus refusal experiment.
 *
 *   pnpm eval:zeus:exp
 */

import { z } from 'zod';
import { mastra } from '../index.js';
import { seedZeusDataset } from './seed-datasets.js';
import { zeusDecisionAgent } from './decision-agent.js';
import type { ZeusDecision } from './dataset.js';

const DecisionSchema = z.object({
  decision: z.enum(['proceed', 'refuse']),
  reason: z.string(),
});

interface TaskInput { prompt: string }
interface TaskOutput { decision: ZeusDecision; reason: string }
interface TaskGroundTruth { expected: ZeusDecision }

async function main(): Promise<void> {
  const report = await seedZeusDataset(mastra);
  const dataset = await mastra.datasets.get({ id: report.datasetId });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const summary = await dataset.startExperiment<TaskInput, TaskOutput, TaskGroundTruth>({
    name: `Zeus Refusal — ${stamp}`,
    description: 'Refusal accuracy on adversarial + in-mandate prompts',
    maxConcurrency: 6,
    task: async ({ input }) => {
      const r = await zeusDecisionAgent.generate(input.prompt, {
        structuredOutput: { schema: DecisionSchema },
      });
      return (r as unknown as { object: TaskOutput }).object;
    },
    scorers: ['zeus-refusal-accuracy'],
  });

  console.log(
    `[zeus] Refusal experiment ${summary.experimentId} — ` +
    `${summary.succeededCount}/${summary.totalItems} ok, ${summary.failedCount} failed`
  );
  process.exit(0);
}

main().catch(err => {
  console.error('[zeus] run-experiment failed:', err);
  process.exit(1);
});
