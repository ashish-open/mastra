/**
 * Persistence helpers used by the reconciliation workflow and routes.
 *
 * Two concerns sit here:
 *   - Run lifecycle + decision audit log (delegates to db.ts)
 *   - Staged-transactions CRUD: uploaded statements live here until a run consumes them
 *
 * The function names are deliberately kept stable for the workflow imports.
 */

import type { NormalizedTxn, RecoDecision } from './types.js';
import {
  dbOpenRecoRun,
  dbGetRecoRun,
  dbWriteRecoDecisions,
  dbStageTransactions,
  dbGetStagedTransactions,
  dbListStagedSources,
  dbDeleteStagedSlot,
  dbListRecoDecisions,
  type StagedSourceSummary,
  type DBRecoRun,
} from './db.js';

/** Look up a single reco run by id, or null when not found. */
export async function getRecoRun(runId: string): Promise<DBRecoRun | null> {
  return dbGetRecoRun(runId);
}

/** All persisted decisions for a run, ordered by insertion. */
export async function listRecoDecisions(runId: string) {
  return dbListRecoDecisions(runId);
}

export async function openRecoRun(args: {
  date: string;
  source: string;
  runId?: string;
}): Promise<{ runId: string; alreadyCompleted: boolean }> {
  return dbOpenRecoRun(args);
}

export async function writeRecoDecisions(args: {
  runId: string;
  decisions: RecoDecision[];
  /** Default true. Set false when staging pending decisions before a
   *  suspend() — the run isn't actually done yet. */
  markCompleted?: boolean;
}): Promise<{ runId: string; written: number }> {
  const result = await dbWriteRecoDecisions(args);
  const stateNote = args.markCompleted === false ? ' (staged, run still open)' : '';
  console.log(`[reco] Wrote ${result.written} decisions for run ${args.runId}${stateNote}`);
  return result;
}

// ─── Staging helpers (used by /reco/upload + workflow source-fetch) ─────────

export async function stageTransactions(args: {
  configId: string;
  adapterId: string;
  date: string;
  txns: NormalizedTxn[];
  filename?: string;
  uploadedBy?: string;
}): Promise<{ count: number; replaced: number }> {
  const r = await dbStageTransactions(args);
  console.log(
    `[reco] Staged ${r.count} txns for config=${args.configId} adapter=${args.adapterId} ` +
    `date=${args.date} (replaced ${r.replaced} prior)`
  );
  return r;
}

export async function getStagedTransactions(
  configId: string,
  adapterId: string,
  date: string,
): Promise<NormalizedTxn[]> {
  return dbGetStagedTransactions(configId, adapterId, date);
}

export async function listStagedSources(
  configId: string,
  date: string,
): Promise<StagedSourceSummary[]> {
  return dbListStagedSources(configId, date);
}

export async function clearStagedSlot(
  configId: string,
  adapterId: string,
  date: string,
): Promise<{ deleted: number }> {
  return dbDeleteStagedSlot(configId, adapterId, date);
}

export type { StagedSourceSummary };
