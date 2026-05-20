/**
 * Seed the Knowledge Bot retrieval eval dataset into Mastra Datasets.
 * Idempotent — skips if already seeded. Wired from `src/mastra/index.ts`.
 */

import type { Mastra } from '@mastra/core/mastra';
import { KNOWLEDGE_CASES } from './dataset.js';

const DATASET_NAME = 'Knowledge Retrieval v1';

interface SeedReport {
  datasetId: string;
  created: boolean;
  itemCount: number;
}

let seedPromise: Promise<SeedReport> | null = null;

export function seedKnowledgeDataset(mastra: Mastra): Promise<SeedReport> {
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
        'Labeled questions for the Knowledge Bot retrieval eval. Each item: ' +
        'a synthetic question; ground truth is the expected source document(s).',
      targetType: 'agent',
      targetIds: ['knowledgeAgent'],
      metadata: { source: 'knowledge-evals/dataset.ts', version: 1 },
    });
    id = ds.id;
    created = true;
    await ds.addItems({
      items: KNOWLEDGE_CASES.map(c => ({
        input: { question: c.question, product: c.product },
        groundTruth: { expectedSources: c.expectedSources },
        metadata: { name: c.name, product: c.product ?? 'cross', notes: c.notes },
      })),
    });
  }

  return { datasetId: id, created, itemCount: KNOWLEDGE_CASES.length };
}
