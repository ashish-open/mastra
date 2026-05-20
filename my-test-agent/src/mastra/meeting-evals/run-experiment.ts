/**
 * Run the meeting action-item extraction experiment.
 *
 *   pnpm eval:meeting:exp
 */

import { z } from 'zod';
import { mastra } from '../index.js';
import { seedMeetingDataset } from './seed-datasets.js';
import { meetingActionItemExtractorAgent } from './extractor-agent.js';
import type { MeetingActionItem } from './dataset.js';

const ExtractorOutputSchema = z.object({
  actionItems: z.array(z.object({
    owner: z.string(),
    task: z.string(),
  })),
});

interface TaskInput { transcript: string; meetingType: string }
interface TaskOutput { actionItems: MeetingActionItem[] }
interface TaskGroundTruth { expectedActionItems: MeetingActionItem[] }

async function main(): Promise<void> {
  const report = await seedMeetingDataset(mastra);
  const dataset = await mastra.datasets.get({ id: report.datasetId });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const summary = await dataset.startExperiment<TaskInput, TaskOutput, TaskGroundTruth>({
    name: `Meeting Action Items — ${stamp}`,
    description: 'Action-item extractor vs labeled synthetic transcripts',
    maxConcurrency: 4,
    task: async ({ input }) => {
      const prompt = `Meeting type: ${input.meetingType}\n\nTranscript:\n${input.transcript}\n\nExtract action items.`;
      const r = await meetingActionItemExtractorAgent.generate(prompt, {
        structuredOutput: { schema: ExtractorOutputSchema },
      });
      return (r as unknown as { object: TaskOutput }).object;
    },
    scorers: ['meeting-action-item-recall'],
  });

  console.log(
    `[meeting] Action-items experiment ${summary.experimentId} — ` +
    `${summary.succeededCount}/${summary.totalItems} ok, ${summary.failedCount} failed`
  );
  process.exit(0);
}

main().catch(err => {
  console.error('[meeting] run-experiment failed:', err);
  process.exit(1);
});
