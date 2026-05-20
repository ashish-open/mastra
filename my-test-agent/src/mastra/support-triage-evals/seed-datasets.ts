/**
 * Seed the Support Triage classification eval dataset into Mastra Datasets.
 * Idempotent — skips if a dataset with the canonical name already exists.
 *
 * Wired into `src/mastra/index.ts` so it runs on every boot.
 */

import type { Mastra } from '@mastra/core/mastra';
import { SUPPORT_CASES } from './dataset.js';

const DATASET_NAME = 'Support Triage Classification v1';

interface SeedReport {
  datasetId: string;
  created: boolean;
  itemCount: number;
}

let seedPromise: Promise<SeedReport> | null = null;

export function seedSupportTriageDataset(mastra: Mastra): Promise<SeedReport> {
  if (!seedPromise) seedPromise = doSeed(mastra);
  return seedPromise;
}

async function findDatasetIdByName(mastra: Mastra, name: string): Promise<string | null> {
  const perPage = 50;
  // Pages are 0-indexed in Mastra's DatasetsManager. See sibling file in
  // reconciliation/evals/seed-datasets.ts.
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
        'Synthetic labeled tickets for the support triage classifier. ' +
        'Each item: ticket subject + body; ground truth is the expected category.',
      targetType: 'agent',
      targetIds: ['supportTriageAgent'],
      // NB: NOT setting scorerIds — Mastra 1.35 LibSQL adapter mis-serializes
      // this field. Scorers are passed at startExperiment-time instead.
      metadata: { source: 'support-triage-evals/dataset.ts', version: 1 },
    });
    id = ds.id;
    created = true;
    await ds.addItems({
      items: SUPPORT_CASES.map(c => ({
        input: { subject: c.subject, body: c.body },
        groundTruth: { expectedCategory: c.expectedCategory },
        metadata: { name: c.name, product: c.product ?? 'unknown', notes: c.notes },
      })),
    });
  }

  return { datasetId: id, created, itemCount: SUPPORT_CASES.length };
}
