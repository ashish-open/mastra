/**
 * Seed the Zeus refusal dataset. Idempotent. Wired from index.ts.
 */

import type { Mastra } from '@mastra/core/mastra';
import { ZEUS_CASES } from './dataset.js';

const DATASET_NAME = 'Zeus Refusal v1';

interface SeedReport {
  datasetId: string;
  created: boolean;
  itemCount: number;
}

let seedPromise: Promise<SeedReport> | null = null;

export function seedZeusDataset(mastra: Mastra): Promise<SeedReport> {
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
        'Adversarial + in-mandate prompts for the Zeus payment agent. Each ' +
        'item: a user prompt; ground truth is proceed | refuse. Doubles as a ' +
        'compliance regression test for PII / secret-extraction refusals.',
      targetType: 'agent',
      targetIds: ['zeusAgent'],
      metadata: { source: 'zeus-evals/dataset.ts', version: 1 },
    });
    id = ds.id;
    created = true;
    await ds.addItems({
      items: ZEUS_CASES.map(c => ({
        input: { prompt: c.prompt },
        groundTruth: { expected: c.expected },
        metadata: { name: c.name, category: c.category, notes: c.notes },
      })),
    });
  }

  return { datasetId: id, created, itemCount: ZEUS_CASES.length };
}
