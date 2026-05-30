/**
 * Execute a validated SELECT and return a PII-masked result envelope.
 *
 * Contract — the validator (`validator.ts`) MUST have run first and returned
 * `ok=true`. This module re-checks the shape defensively (trust-but-verify)
 * but is not designed to be safe against arbitrary input on its own.
 *
 * What this module does (and does not do):
 *
 *   ✓ Run the query inside an explicit read-only transaction.
 *   ✓ Cap returned rows at `ROW_CAP` (matches validator's injected LIMIT).
 *   ✓ Walk every cell and mask any whose column name matches the PII rules.
 *   ✓ Report which columns were masked (so the narrator can mention it).
 *   ✓ Time the query — surfaced to the caller for observability.
 *
 *   ✗ Format the result for the user. That's the narrator agent's job.
 *   ✗ Do paging / streaming. Out of scope for v1.
 *
 * Why an explicit `BEGIN READ ONLY` even though the pool already sets
 * `default_transaction_read_only=on`: belt-and-braces. Some Postgres
 * frontends issue `RESET ALL` on checkout which would drop the default; the
 * BEGIN guarantees the property for this statement specifically.
 */

import { getConnection } from './connections.js';
import { isPii, maskValue } from './pii.js';
import type { ConnectionId, QueryResult } from './types.js';

const ROW_CAP = Number(process.env.DB_QUERY_ROW_CAP ?? 1_000);

/**
 * Tables that the executed SQL references, in (schema, table) form. The
 * caller supplies this — we don't re-parse the SQL. It is used to drive PII
 * column lookups by `schema.table`. If null/empty, PII rules with explicit
 * table targets will not fire (catch-all `'*'` rules still apply via column
 * name alone).
 */
export interface RunSqlOptions {
  tablesReferenced?: Array<{ schema: string; table: string }>;
}

/**
 * Run a validated SELECT. Returns a `QueryResult` with masked rows and
 * metadata. Never throws on PII matches — masks silently and reports the
 * column names in `piiMasked`.
 *
 * Throws on:
 *   - SQL execution error (bubble up the pg error; the caller already
 *     EXPLAIN'd so this should be rare in practice — transient errors only)
 *   - Sanity-check fail (statement is not a SELECT/WITH after all)
 */
export async function runValidatedSql(
  connectionId: ConnectionId,
  sql: string,
  opts: RunSqlOptions = {},
): Promise<QueryResult> {
  // Defensive shape re-check. Cheap; protects against accidental misuse where
  // a caller bypasses the validator.
  const head = sql.trim().slice(0, 10).toUpperCase();
  if (!head.startsWith('SELECT') && !head.startsWith('WITH')) {
    throw new Error('runValidatedSql: only SELECT / WITH ... SELECT statements are runnable.');
  }

  const conn = getConnection(connectionId);
  const t0 = Date.now();

  const client = await conn.pool.connect();
  let rows: Array<Record<string, unknown>>;
  let truncated = false;
  try {
    await client.query('BEGIN READ ONLY');
    try {
      // We rely on the validator-injected LIMIT (or the user's own LIMIT) to
      // bound rows. We additionally cap at ROW_CAP defensively in case the
      // LIMIT was wrong or the EXPLAIN row estimate was way off.
      const res = await client.query<Record<string, unknown>>(sql);
      rows = res.rows;
      if (rows.length > ROW_CAP) {
        rows = rows.slice(0, ROW_CAP);
        truncated = true;
      }
    } finally {
      await client.query('COMMIT');
    }
  } finally {
    client.release();
  }

  // PII masking. We need column → source-table mapping; we don't have it
  // post-execution from pg-node, so we use a heuristic: apply rules from
  // every referenced table (caller-supplied) plus the catch-all '*' rules,
  // matching on column name only. If a column matches any rule for any
  // referenced table, mask it.
  const piiMaskedSet = new Set<string>();
  const tables = opts.tablesReferenced ?? [];

  // Empty-row fast path — no columns to walk.
  if (rows.length > 0) {
    const colNames = Object.keys(rows[0]);
    const masksByCol = new Map<string, { masked: boolean; reason?: string }>();
    for (const col of colNames) {
      let hit: { masked: boolean; reason?: string } = { masked: false };
      if (tables.length === 0) {
        // Apply catch-all rules using a dummy table name.
        hit = isPii(connectionId, 'public', '__unknown__', col);
      } else {
        for (const t of tables) {
          const r = isPii(connectionId, t.schema, t.table, col);
          if (r.masked) {
            hit = r;
            break;
          }
        }
      }
      masksByCol.set(col, hit);
      if (hit.masked) piiMaskedSet.add(col);
    }

    if (piiMaskedSet.size > 0) {
      for (const row of rows) {
        for (const col of piiMaskedSet) {
          row[col] = maskValue(row[col]);
        }
      }
    }
  }

  return {
    rows,
    rowCount: rows.length,
    truncated,
    piiMasked: [...piiMaskedSet].sort(),
    ms: Date.now() - t0,
  };
}
