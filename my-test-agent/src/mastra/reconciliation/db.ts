/**
 * Durable persistence for reconciliation runs + decisions.
 *
 * Replaces the in-memory Maps that used to live in tools.ts. Backed by LibSQL
 * (SQLite-compatible) at the path in RECO_DB_URL or `file:./reco.db`. Two
 * tables:
 *
 *   reco_runs(id PK, date, source, state, created_at, updated_at)
 *     UNIQUE on (date, source) — idempotency anchor for re-runs
 *
 *   reco_decisions(id PK, run_id FK, source_txn_id, target_txn_id, match_type,
 *                  amount_delta_paise, decided_by, matcher_version, reasoning,
 *                  created_at)
 *     FK cascades on run delete (we never delete runs in practice).
 *
 * Why LibSQL and not Postgres: matches what Mastra already uses for its own
 * storage (mastra.db) — no extra dependency, no extra service to run. When
 * the OpenArc side persists this to Postgres for cross-team reporting, that
 * mirror table is the source of truth for analytics; this one stays the
 * Mastra-side audit log.
 */

import { createClient, type Client } from '@libsql/client';
import type { RecoDecision } from './types.js';

const DB_URL = process.env.RECO_DB_URL ?? 'file:./reco.db';

// Lazy singleton — first use creates the client and ensures the schema exists.
let _client: Client | null = null;
let _schemaReady: Promise<void> | null = null;

function getClient(): Client {
  if (!_client) _client = createClient({ url: DB_URL });
  return _client;
}

async function ensureSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const c = getClient();
    await c.executeMultiple(`
      CREATE TABLE IF NOT EXISTS reco_runs (
        id          TEXT PRIMARY KEY,
        date        TEXT NOT NULL,
        source      TEXT NOT NULL,
        state       TEXT NOT NULL DEFAULT 'open',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reco_runs_date_source ON reco_runs(date, source);
      CREATE INDEX IF NOT EXISTS idx_reco_runs_state ON reco_runs(state);
      CREATE INDEX IF NOT EXISTS idx_reco_runs_created_at ON reco_runs(created_at DESC);

      CREATE TABLE IF NOT EXISTS reco_decisions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id             TEXT NOT NULL,
        source_txn_id      TEXT NOT NULL,
        target_txn_id      TEXT,
        match_type         TEXT NOT NULL,
        amount_delta_paise INTEGER NOT NULL DEFAULT 0,
        decided_by         TEXT NOT NULL,
        matcher_version    TEXT NOT NULL,
        reasoning          TEXT,
        created_at         TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES reco_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reco_decisions_run_id     ON reco_decisions(run_id);
      CREATE INDEX IF NOT EXISTS idx_reco_decisions_match_type ON reco_decisions(match_type);
      CREATE INDEX IF NOT EXISTS idx_reco_decisions_created_at ON reco_decisions(created_at DESC);
    `);
    console.log(`[reco-db] schema ready @ ${DB_URL}`);
  })();
  return _schemaReady;
}

// ─── Run lifecycle ───────────────────────────────────────────────────────────

export interface DBRecoRun {
  id: string;
  date: string;
  source: string;
  state: 'open' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

/**
 * Idempotent: if a run already exists for (date, source) and is 'completed',
 * return that runId with alreadyCompleted=true. Otherwise create (or reuse
 * an open one) and return alreadyCompleted=false.
 */
export async function dbOpenRecoRun(args: {
  date: string;
  source: string;
  runId?: string;
}): Promise<{ runId: string; alreadyCompleted: boolean }> {
  await ensureSchema();
  const c = getClient();
  const now = new Date().toISOString();

  // Look up existing by (date, source)
  const existing = await c.execute({
    sql: 'SELECT id, state FROM reco_runs WHERE date = ? AND source = ? LIMIT 1',
    args: [args.date, args.source],
  });
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as unknown as { id: string; state: string };
    if (row.state === 'completed') {
      return { runId: row.id, alreadyCompleted: true };
    }
    // Open run exists — reuse its id, refresh updated_at
    await c.execute({
      sql: 'UPDATE reco_runs SET updated_at = ? WHERE id = ?',
      args: [now, row.id],
    });
    return { runId: row.id, alreadyCompleted: false };
  }

  const id = args.runId ?? `reco_${args.source}_${args.date}_${Date.now()}`;
  await c.execute({
    sql: `INSERT INTO reco_runs (id, date, source, state, created_at, updated_at)
          VALUES (?, ?, ?, 'open', ?, ?)`,
    args: [id, args.date, args.source, now, now],
  });
  return { runId: id, alreadyCompleted: false };
}

/**
 * Marks the run as completed AND persists every decision in one go.
 * Idempotent on (run_id, source_txn_id) via INSERT OR REPLACE so retries
 * don't duplicate.
 */
export async function dbWriteRecoDecisions(args: {
  runId: string;
  decisions: RecoDecision[];
}): Promise<{ runId: string; written: number }> {
  await ensureSchema();
  const c = getClient();
  const now = new Date().toISOString();

  // Batch insert. LibSQL supports executeMultiple but each row needs its own
  // bound params, so we use a transaction with individual statements.
  const tx = await c.transaction('write');
  try {
    // Delete any prior rows for this run (idempotent retry) — cheap since
    // we expect <100 decisions per run for our scale.
    await tx.execute({
      sql: 'DELETE FROM reco_decisions WHERE run_id = ?',
      args: [args.runId],
    });

    for (const d of args.decisions) {
      await tx.execute({
        sql: `INSERT INTO reco_decisions
              (run_id, source_txn_id, target_txn_id, match_type,
               amount_delta_paise, decided_by, matcher_version, reasoning, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          args.runId,
          d.sourceTxnId,
          d.targetTxnId ?? null,
          d.matchType,
          d.amountDeltaPaise ?? 0,
          d.decidedBy,
          d.matcherVersion,
          d.reasoning ?? null,
          now,
        ],
      });
    }

    await tx.execute({
      sql: `UPDATE reco_runs SET state = 'completed', updated_at = ? WHERE id = ?`,
      args: [now, args.runId],
    });

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return { runId: args.runId, written: args.decisions.length };
}

// ─── Read APIs (used by /integration/reco/* routes) ─────────────────────────

export async function dbListRecoRuns(opts: { limit?: number } = {}): Promise<DBRecoRun[]> {
  await ensureSchema();
  const c = getClient();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const r = await c.execute({
    sql: `SELECT id, date, source, state, created_at, updated_at
          FROM reco_runs
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [limit],
  });
  return r.rows.map(row => ({
    id: row.id as string,
    date: row.date as string,
    source: row.source as string,
    state: row.state as DBRecoRun['state'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export interface DBRecoDecisionRow extends RecoDecision {
  runId: string;
  createdAt: string;
}

export async function dbListRecoDecisions(runId: string): Promise<DBRecoDecisionRow[]> {
  await ensureSchema();
  const c = getClient();
  const r = await c.execute({
    sql: `SELECT run_id, source_txn_id, target_txn_id, match_type,
                 amount_delta_paise, decided_by, matcher_version, reasoning, created_at
          FROM reco_decisions
          WHERE run_id = ?
          ORDER BY id ASC`,
    args: [runId],
  });
  return r.rows.map(row => ({
    runId: row.run_id as string,
    sourceTxnId: row.source_txn_id as string,
    targetTxnId: (row.target_txn_id as string | null) ?? null,
    matchType: row.match_type as RecoDecision['matchType'],
    amountDeltaPaise: row.amount_delta_paise as number,
    decidedBy: row.decided_by as string,
    matcherVersion: row.matcher_version as string,
    reasoning: (row.reasoning as string | null) ?? undefined,
    createdAt: row.created_at as string,
  }));
}
