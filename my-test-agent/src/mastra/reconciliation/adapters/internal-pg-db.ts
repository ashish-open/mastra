/**
 * internal-pg-db adapter — looks up our internal `py_id` records by the
 * candidate identifiers from the current reco run.
 *
 * Purpose (per Phase 1.6 of the v2 plan):
 *
 *   The SOP requires confirming that each PG-side MIS row exists in our
 *   internal PG-transactions record. The PG MIS file doesn't carry our
 *   `py_id`; we have to look it up via the composite (UTR, amount, payer_vpa)
 *   match. This adapter encapsulates that lookup as just another "source"
 *   the leg runner can match against.
 *
 *   Architecturally it's a SourceAdapter, but it doesn't do `parseFile()`
 *   (no upload) and its `fetch()` ignores the date range — instead it pulls
 *   from the in-memory pool of the prior leg via a sidecar hook configured
 *   on the leg.
 *
 * v1 behaviour (stub):
 *
 *   This file ships as an interface scaffold. The actual DB query is gated
 *   behind RECO_INTERNAL_PG_DB_URL: when unset (dev / pilot), the adapter
 *   returns an empty array — leg 2 will then mark everything as unmatched
 *   for the DB-confirm step. When set (production), the adapter will run a
 *   batched SELECT against the internal pg_transactions table.
 *
 *   Phase 3 of the rollout switches the stub for a real query once the
 *   production DSN is in place. The adapter contract is stable; switching
 *   implementations doesn't change the leg config.
 *
 * Why a stub now: it lets the YES Bank pilot config name `internal-pg-db`
 * as a real source (leg 2 wires it in), and gives finance team a
 * dry-run path with the real files. Once the DB DSN lands, the cross-check
 * activates without any config change.
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';

/**
 * Bulk-lookup options. Populated by a "context provider" the leg runner
 * injects via `options` — we keep the join-key snapshot opaque (string[])
 * so the adapter doesn't have to know the schema of the calling leg.
 */
export interface InternalPgDbLookupOptions {
  /** PG partner name (e.g. 'yes', 'npst'). Picks which table/index to query. */
  pgName: string;
  /**
   * Candidate join-key tuples from the prior leg, one per row to look up.
   * The adapter uses these to constrain the SELECT to a manageable size
   * (don't pull the entire pg_transactions table — we know exactly which
   * UTRs / amounts / VPAs to ask for).
   */
  candidates?: Array<{ utr?: string | null; amountPaise: number; payerVpa?: string | null }>;
}

async function fetchInternalPgRows(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
  const opts = ctx.options as InternalPgDbLookupOptions | undefined;
  const pgName = opts?.pgName ?? 'unknown';
  const candidates = opts?.candidates ?? [];

  const dsn = process.env.RECO_INTERNAL_PG_DB_URL;
  if (!dsn) {
    console.warn(
      `[internal-pg-db] adapter invoked for pg='${pgName}' on date=${ctx.date} ` +
      `with ${candidates.length} candidate keys, but RECO_INTERNAL_PG_DB_URL is unset. ` +
      `Returning empty result — leg's DB-confirm step will mark all rows as unmatched. ` +
      `Set the DSN to enable real cross-check (Phase 3).`,
    );
    return [];
  }

  // Real DB query lives here when the DSN is provisioned. Pattern:
  //
  //   const client = createClient({ url: dsn });
  //   const rows = await client.execute({
  //     sql: `SELECT py_id, utr, amount, payer_vpa, created_at
  //           FROM pg_transactions
  //           WHERE pg_name = ?
  //             AND DATE(created_at) BETWEEN ? AND ?
  //             AND utr = ANY(?)`,
  //     args: [pgName, ctx.date, ctx.date, candidates.map(c => c.utr).filter(Boolean)],
  //   });
  //   return rows.rows.map(r => ({
  //     sourceId: `pyid_${r.py_id}`,
  //     source: 'internal-pg-db',
  //     pyId: r.py_id,
  //     utr: r.utr,
  //     amountPaise: Math.round(r.amount * 100),
  //     payerVpa: r.payer_vpa,
  //     date: ctx.date,
  //     raw: r,
  //   }));
  //
  // For now: not implemented. Throwing here would block the pilot, so we
  // log loudly and return empty.
  console.warn(
    `[internal-pg-db] RECO_INTERNAL_PG_DB_URL set but query is not yet implemented for pg='${pgName}'. ` +
    `Wire up the real SELECT in src/mastra/reconciliation/adapters/internal-pg-db.ts before relying on this in production.`,
  );
  return [];
}

export const internalPgDbAdapter: SourceAdapter = {
  id: 'internal-pg-db',
  name: 'Internal PG Database (py_id lookup)',
  kind: 'internal',
  // Note: no parseFile — this adapter never receives uploads. The leg runner
  // injects candidate join keys via ctx.options.candidates; the adapter
  // returns matching rows. Until the DSN is configured this is a no-op stub.
  fetch: fetchInternalPgRows,
};
