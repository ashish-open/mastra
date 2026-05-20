/**
 * Seed Mastra Datasets from the labeled TS cases in `dataset.ts`.
 *
 * Goal: surface our eval cases in Studio → Datasets, so that Studio →
 * Experiments can run against them and show deltas over time. Without this,
 * `FUZZY_CASES` / `DISPOSITION_CASES` only existed as in-memory arrays for
 * the offline `pnpm eval:reco` runner — invisible to Studio.
 *
 * Contract:
 *   - Idempotent: skips if a dataset with the canonical name already exists.
 *   - Versioned via the name suffix (`v1`). When the underlying cases shift
 *     in meaningful ways, bump the version constant — a new dataset is
 *     created rather than mutating history.
 *   - Each dataset item carries `input` (what the agent sees) and
 *     `groundTruth` (the expected output) plus `metadata` (category, name,
 *     configId) so Studio filters and per-category breakdowns work.
 *
 * Wired from `src/mastra/index.ts` after the Mastra instance is constructed.
 */

import type { Mastra } from '@mastra/core/mastra';
import { FUZZY_CASES, DISPOSITION_CASES } from './dataset.js';

const FUZZY_DATASET_NAME = 'Reco Fuzzy Match v1';
const DISPOSITION_DATASET_NAME = 'Reco Disposition v1';

interface SeedReport {
  fuzzy: { datasetId: string; created: boolean; itemCount: number };
  disposition: { datasetId: string; created: boolean; itemCount: number };
}

/**
 * Find a dataset by exact name match (Studio's list is small enough that
 * scanning every page is acceptable).
 */
async function findDatasetIdByName(mastra: Mastra, name: string): Promise<string | null> {
  const perPage = 50;
  // Mastra's datasets.list pagination is 0-indexed (DatasetsManager defaults
  // page to 0). Starting at page=1 silently skipped the first page and
  // caused every cold process to mis-create duplicates.
  for (let page = 0; page < 20; page++) {
    const { datasets, pagination } = await mastra.datasets.list({ page, perPage });
    const hit = datasets.find(d => d.name === name);
    if (hit) return hit.id;
    if (!pagination.hasMore) return null;
  }
  return null;
}

/**
 * Module-level promise cache. The Mastra app boot path kicks off this seed
 * fire-and-forget; the experiment-runner script also awaits it. Without a
 * cache, both run in parallel and create duplicate datasets (the LibSQL
 * datasets adapter doesn't enforce unique names). With the cache, the second
 * caller awaits the first call's result.
 */
let seedPromise: Promise<SeedReport> | null = null;

export function seedRecoDatasets(mastra: Mastra): Promise<SeedReport> {
  if (!seedPromise) seedPromise = doSeed(mastra);
  return seedPromise;
}

async function doSeed(mastra: Mastra): Promise<SeedReport> {
  // ─── Fuzzy match dataset ────────────────────────────────────────────────
  let fuzzyId = await findDatasetIdByName(mastra, FUZZY_DATASET_NAME);
  let fuzzyCreated = false;
  if (!fuzzyId) {
    const ds = await mastra.datasets.create({
      name: FUZZY_DATASET_NAME,
      description:
        'Labeled cases for the reco fuzzy-match agent. Each item: an unmatched ' +
        'transaction + a candidate pool; ground truth is the expected best candidate.',
      targetType: 'agent',
      targetIds: ['fuzzyMatchAgent'],
      // NB: NOT setting scorerIds on the dataset record. In Mastra 1.35 the
      // LibSQL datasets adapter stores scorerIds as a JSON string and reads
      // it back without parsing — when runExperiment spreads it into the
      // scorer list it iterates the string's characters and produces
      // "Scorer with id [ not found". Pass scorers at startExperiment-time
      // instead (run-experiment.ts).
      metadata: { source: 'reconciliation/evals/dataset.ts', version: 1 },
    });
    fuzzyId = ds.id;
    fuzzyCreated = true;
    await ds.addItems({
      items: FUZZY_CASES.map(c => ({
        input: c.input,
        groundTruth: c.expected,
        metadata: {
          name: c.name,
          category: c.category,
          configId: c.configId ?? 'common',
          notes: c.notes,
        },
      })),
    });
  }

  // ─── Disposition dataset ────────────────────────────────────────────────
  let dispId = await findDatasetIdByName(mastra, DISPOSITION_DATASET_NAME);
  let dispCreated = false;
  if (!dispId) {
    const ds = await mastra.datasets.create({
      name: DISPOSITION_DATASET_NAME,
      description:
        'Labeled cases for the reco disposition agent. Each item: a fuzzy match ' +
        'result + source txn; ground truth is the expected recommendation.',
      targetType: 'agent',
      targetIds: ['dispositionAgent'],
      // See note on fuzzy dataset above re: omitting scorerIds.
      metadata: { source: 'reconciliation/evals/dataset.ts', version: 1 },
    });
    dispId = ds.id;
    dispCreated = true;
    await ds.addItems({
      items: DISPOSITION_CASES.map(c => ({
        input: c.input,
        groundTruth: c.expected,
        metadata: {
          name: c.name,
          category: c.category,
          configId: c.configId ?? 'common',
          notes: c.notes,
        },
      })),
    });
  }

  return {
    fuzzy: { datasetId: fuzzyId!, created: fuzzyCreated, itemCount: FUZZY_CASES.length },
    disposition: { datasetId: dispId!, created: dispCreated, itemCount: DISPOSITION_CASES.length },
  };
}
