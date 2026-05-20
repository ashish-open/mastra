/**
 * Seed the Meeting Summarizer action-item dataset into Mastra Datasets.
 * Idempotent. Wired from `src/mastra/index.ts`.
 */

import type { Mastra } from '@mastra/core/mastra';
import { MEETING_CASES } from './dataset.js';

const DATASET_NAME = 'Meeting Action Items v1';

interface SeedReport {
  datasetId: string;
  created: boolean;
  itemCount: number;
}

let seedPromise: Promise<SeedReport> | null = null;

export function seedMeetingDataset(mastra: Mastra): Promise<SeedReport> {
  if (!seedPromise) seedPromise = doSeed(mastra);
  return seedPromise;
}

async function findDatasetIdByName(mastra: Mastra, name: string): Promise<string | null> {
  const perPage = 50;
  for (let page = 0; page < 20; page++) {
    const { datasets, pagination } = await mastra.datasets.list({ page, perPage });
    const hit = datasets.find(d => d.name === name);
    if (hit) return hit.id;
    if (!pagination.hasMore) return null;
  }
  return null;
}

async function doSeed(mastra: Mastra): Promise<SeedReport> {
  let id = await findDatasetIdByName(mastra, DATASET_NAME);
  let created = false;

  if (!id) {
    const ds = await mastra.datasets.create({
      name: DATASET_NAME,
      description:
        'Synthetic meeting transcripts labeled with expected action items. ' +
        'Each item: a transcript; ground truth is the expectedActionItems array.',
      targetType: 'agent',
      targetIds: ['meetingAgent'],
      metadata: { source: 'meeting-evals/dataset.ts', version: 1 },
    });
    id = ds.id;
    created = true;
    await ds.addItems({
      items: MEETING_CASES.map(c => ({
        input: { transcript: c.transcript, meetingType: c.meetingType },
        groundTruth: { expectedActionItems: c.expectedActionItems },
        metadata: { name: c.name, meetingType: c.meetingType, notes: c.notes },
      })),
    });
  }

  return { datasetId: id, created, itemCount: MEETING_CASES.length };
}
