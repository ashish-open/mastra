/**
 * Persistence + run-tracking helpers for the reconciliation workflow.
 *
 * These delegate to `db.ts` (LibSQL-backed). The function names are kept
 * stable for the workflow that imports them. The old in-memory Maps were
 * replaced because they were wiped on every `pnpm dev` restart, causing
 * OpenArc to see "no decisions" for any run that predated the restart.
 *
 * Workflow side imports these directly. Read-side (integration routes)
 * import the dbList* functions from db.ts.
 */

import type { RecoDecision } from './types.js';
import { dbOpenRecoRun, dbWriteRecoDecisions } from './db.js';

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
}): Promise<{ runId: string; written: number }> {
  const result = await dbWriteRecoDecisions(args);
  console.log(`[reco] Wrote ${result.written} decisions for run ${args.runId}`);
  return result;
}
