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
import type { NormalizedTxn, RecoDecision } from './types.js';

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
      -- See "v2.1 migrations" block below for the partial-unique replacement.
      -- We keep this legacy index creation conditional so fresh DBs don't get
      -- the broken full-unique constraint that conflicts with state='superseded'
      -- coexistence. The migration drops it and creates the partial variant.
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
        metadata           TEXT, -- JSON; nullable; carries structured details (batchId, batchSize, etc.)
        created_at         TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES reco_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reco_decisions_run_id     ON reco_decisions(run_id);
      CREATE INDEX IF NOT EXISTS idx_reco_decisions_match_type ON reco_decisions(match_type);
      CREATE INDEX IF NOT EXISTS idx_reco_decisions_created_at ON reco_decisions(created_at DESC);

      -- Staging table: parsed-but-not-yet-reconciled rows. Populated by the
      -- /reco/upload route (or by real-API fetch fallback in the workflow).
      -- A reconciliation run reads from here for every source declared in its
      -- ReconcileConfig; if a source has zero staged rows AND the adapter has
      -- no fetch() fallback, the run fails with a clear error.
      --
      -- UNIQUE(config_id, adapter_id, date, source_id) gives idempotent upsert:
      -- re-uploading the same statement file replaces those rows exactly.
      CREATE TABLE IF NOT EXISTS reco_staged_transactions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        config_id      TEXT NOT NULL,
        adapter_id     TEXT NOT NULL,
        date           TEXT NOT NULL,
        source_id      TEXT NOT NULL,
        payload        TEXT NOT NULL,
        uploaded_at    TEXT NOT NULL,
        uploaded_by    TEXT,
        filename       TEXT,
        UNIQUE (config_id, adapter_id, date, source_id)
      );
      CREATE INDEX IF NOT EXISTS idx_reco_stage_lookup
        ON reco_staged_transactions(config_id, adapter_id, date);
      CREATE INDEX IF NOT EXISTS idx_reco_stage_uploaded_at
        ON reco_staged_transactions(uploaded_at DESC);
      -- Join index for dbListRecoDecisions' LEFT JOINs (which key on
      -- config_id + date + source_id, WITHOUT adapter_id). The unique index
      -- leads with (config_id, adapter_id, ...) so it can only serve the
      -- config_id prefix here — meaning every decision row full-scanned the
      -- staging table (O(decisions × staged) ≈ 20B ops at 145k×143k). This
      -- index matches the join columns exactly → O(log n) lookups.
      CREATE INDEX IF NOT EXISTS idx_reco_stage_join
        ON reco_staged_transactions(config_id, date, source_id);
    `);

    // ─── Idempotent column-add migrations ──────────────────────────────────
    // SQLite has no `ADD COLUMN IF NOT EXISTS`; the canonical pattern is to
    // attempt the ALTER and swallow the "duplicate column name" error. Cheap
    // on every boot, lets old DBs upgrade in place without a separate migration
    // tool.
    const safeAddColumn = async (sql: string) => {
      try {
        await c.execute(sql);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (!/duplicate column name/i.test(msg)) throw e;
      }
    };
    // v2.1: structured decision metadata (batchId, batchSize, etc.)
    await safeAddColumn('ALTER TABLE reco_decisions ADD COLUMN metadata TEXT');

    // v2.2 (Phase 1): add `mode` to staging table so a single config can hold
    // separate UPI / CC / DC / NB files without colliding. The legacy table
    // had `UNIQUE(config_id, adapter_id, date, source_id)`; the new
    // partial unique index treats COALESCE(mode, '') as part of the key so
    // legacy configs (mode=NULL) keep their existing one-row-per-slot
    // semantics while multi-mode configs can stage multiple modes side-by-side.
    //
    // We rebuild the table only if `mode` column is absent (idempotent on
    // already-migrated dbs).
    {
      const probe = await c.execute({
        sql: "SELECT COUNT(*) AS c FROM pragma_table_info('reco_staged_transactions') WHERE name = 'mode'",
        args: [],
      });
      const modeExists = Number((probe.rows[0] as unknown as { c: number | string }).c) > 0;
      if (!modeExists) {
        await c.batch(
          [
            // 1. Build a parallel table with the new schema (no table-level UNIQUE).
            `CREATE TABLE reco_staged_transactions__v2 (
               id             INTEGER PRIMARY KEY AUTOINCREMENT,
               config_id      TEXT NOT NULL,
               adapter_id     TEXT NOT NULL,
               date           TEXT NOT NULL,
               source_id      TEXT NOT NULL,
               mode           TEXT,
               payload        TEXT NOT NULL,
               uploaded_at    TEXT NOT NULL,
               uploaded_by    TEXT,
               filename       TEXT
             )`,
            // 2. Copy legacy rows (mode = NULL).
            `INSERT INTO reco_staged_transactions__v2
               (id, config_id, adapter_id, date, source_id, mode, payload, uploaded_at, uploaded_by, filename)
             SELECT id, config_id, adapter_id, date, source_id, NULL, payload, uploaded_at, uploaded_by, filename
             FROM reco_staged_transactions`,
            // 3. Swap.
            'DROP TABLE reco_staged_transactions',
            'ALTER TABLE reco_staged_transactions__v2 RENAME TO reco_staged_transactions',
            // 4. Recreate non-unique lookup indexes.
            `CREATE INDEX IF NOT EXISTS idx_reco_stage_lookup
               ON reco_staged_transactions(config_id, adapter_id, date)`,
            `CREATE INDEX IF NOT EXISTS idx_reco_stage_uploaded_at
               ON reco_staged_transactions(uploaded_at DESC)`,
            // Join index (config_id, date, source_id) — see ensureSchema note.
            `CREATE INDEX IF NOT EXISTS idx_reco_stage_join
               ON reco_staged_transactions(config_id, date, source_id)`,
            // 5. New unique constraint — COALESCE(mode,'') so NULL collapses
            // to a single deterministic slot per (config, adapter, date, source_id).
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_reco_stage_unique_v2
               ON reco_staged_transactions(config_id, adapter_id, date, source_id, COALESCE(mode, ''))`,
          ],
          'write',
        );
        console.log('[reco-db] migrated reco_staged_transactions to v2 (added mode column + new unique index)');
      }
    }

    // v2.1: replace the full unique index on (date, source) with a partial one
    // that only enforces uniqueness across ACTIVE states. Without this, a
    // legitimate re-upload flow (which marks the prior run 'superseded' and
    // expects the next workflow to insert a fresh row) hits a UNIQUE
    // constraint violation because superseded rows still occupy the slot.
    //
    // Partial index semantics (SQLite ≥ 3.8.0): the constraint applies only
    // to rows matching the WHERE clause. So:
    //   - At most one 'open' / 'completed' / 'failed' row per (date, source).
    //   - Unlimited 'superseded' rows can stack up for audit trail.
    //
    // Idempotent: DROP IF EXISTS the legacy index, CREATE IF NOT EXISTS the
    // new one. Safe across fresh + upgraded DBs.
    await c.execute('DROP INDEX IF EXISTS idx_reco_runs_date_source');
    await c.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reco_runs_date_source_active
        ON reco_runs(date, source)
        WHERE state != 'superseded'
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

  // Look up the active (non-superseded) run for (date, source). The partial
  // unique index `idx_reco_runs_date_source_active` guarantees at most one
  // row matches, so LIMIT 1 is a safety belt rather than a tiebreaker.
  // Superseded rows are intentionally ignored — they represent prior
  // completions invalidated by a fresh upload, and shouldn't block the next
  // run from starting.
  const existing = await c.execute({
    sql: `SELECT id, state FROM reco_runs
          WHERE date = ? AND source = ? AND state != 'superseded'
          ORDER BY created_at DESC LIMIT 1`,
    args: [args.date, args.source],
  });
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as unknown as { id: string; state: string };
    if (row.state === 'completed') {
      // Idempotent: the latest run for this slot is fully done with the
      // currently-staged data — skip the rerun.
      return { runId: row.id, alreadyCompleted: true };
    }
    if (row.state === 'open') {
      // An in-flight or freshly-opened run exists — reuse its id.
      await c.execute({
        sql: 'UPDATE reco_runs SET updated_at = ? WHERE id = ?',
        args: [now, row.id],
      });
      return { runId: row.id, alreadyCompleted: false };
    }
    // 'failed' — fall through to create a new row.
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
 * Persists every decision for a run. By default also flips the run to
 * `state='completed'` — pass `markCompleted: false` when staging pending
 * decisions before a suspend (the reviewer hasn't approved yet, so the run
 * is still in-flight).
 *
 * Idempotent on `run_id` via DELETE+INSERT inside a transaction — calling
 * twice for the same run (e.g. once pre-suspend, once post-resume) is safe.
 */
export async function dbWriteRecoDecisions(args: {
  runId: string;
  decisions: RecoDecision[];
  markCompleted?: boolean;
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
               amount_delta_paise, decided_by, matcher_version, reasoning,
               metadata, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          args.runId,
          d.sourceTxnId,
          d.targetTxnId ?? null,
          d.matchType,
          d.amountDeltaPaise ?? 0,
          d.decidedBy,
          d.matcherVersion,
          d.reasoning ?? null,
          d.metadata ? JSON.stringify(d.metadata) : null,
          now,
        ],
      });
    }

    if (args.markCompleted !== false) {
      await tx.execute({
        sql: `UPDATE reco_runs SET state = 'completed', updated_at = ? WHERE id = ?`,
        args: [now, args.runId],
      });
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return { runId: args.runId, written: args.decisions.length };
}

/**
 * Flip a run's state to 'completed' without touching reco_decisions.
 *
 * Used by the workflow's writeDecisionsStep when decisions were already
 * persisted earlier (settlement configs with llm='off' write inline inside
 * deterministicMatchStep to keep the workflow snapshot small — calling
 * dbWriteRecoDecisions again with an empty array would DELETE those rows).
 */
export async function dbMarkRunComplete(runId: string): Promise<void> {
  await ensureSchema();
  const c = getClient();
  const now = new Date().toISOString();
  await c.execute({
    sql: `UPDATE reco_runs SET state = 'completed', updated_at = ? WHERE id = ?`,
    args: [now, runId],
  });
}

// ─── Read APIs (used by /integration/reco/* routes) ─────────────────────────

/**
 * Single-run lookup by id. Returns null when the run isn't in the DB —
 * callers use this to surface a clean 404 / "Run not found" UI message.
 */
export async function dbGetRecoRun(runId: string): Promise<DBRecoRun | null> {
  await ensureSchema();
  const c = getClient();
  const r = await c.execute({
    sql: `SELECT id, date, source, state, created_at, updated_at
          FROM reco_runs WHERE id = ? LIMIT 1`,
    args: [runId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as unknown as { id: string; date: string; source: string; state: DBRecoRun['state']; created_at: string; updated_at: string };
  return {
    id: row.id,
    date: row.date,
    source: row.source,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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
  /** Amount of the source txn (Razorpay/Swiggy/POS row). Null if not staged. */
  sourceAmountPaise: number | null;
  /** Amount of the target txn (bank row). Null when targetTxnId is null. */
  targetAmountPaise: number | null;
  /** Counterparty of the source txn (e.g. 'Razorpay', 'Acme Corp'). */
  sourceCounterparty: string | null;
  /** Counterparty/narration of the target row (e.g. 'ZWITCH SETTLEMENT'). */
  targetCounterparty: string | null;
}

// ─── Staged transactions ─────────────────────────────────────────────────────

export interface StagedSourceSummary {
  configId: string;
  adapterId: string;
  date: string;
  count: number;
  uploadedAt: string;
  filename: string | null;
}

/**
 * Idempotent upsert: stage one batch of parsed transactions for a
 * (config, adapter, date) slot. Re-uploading the same statement replaces
 * the prior rows under that slot — old uploads for OTHER dates / configs
 * remain untouched.
 *
 * Uses a transaction + INSERT OR REPLACE so retries and overlapping requests
 * don't double-count.
 */
export async function dbStageTransactions(args: {
  configId: string;
  adapterId: string;
  date: string;
  txns: NormalizedTxn[];
  filename?: string;
  uploadedBy?: string;
}): Promise<{ count: number; replaced: number; invalidatedRuns: number }> {
  await ensureSchema();
  const c = getClient();
  const now = new Date().toISOString();

  const tx = await c.transaction('write');
  try {
    // Wipe prior staged rows for this slot. Cheap (<= a few thousand rows
    // per statement) and gives us clean replace-semantics — partial uploads
    // can't leave orphaned old rows behind.
    const prior = await tx.execute({
      sql: 'DELETE FROM reco_staged_transactions WHERE config_id = ? AND adapter_id = ? AND date = ?',
      args: [args.configId, args.adapterId, args.date],
    });

    for (const t of args.txns) {
      await tx.execute({
        sql: `INSERT INTO reco_staged_transactions
              (config_id, adapter_id, date, source_id, payload, uploaded_at, uploaded_by, filename)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          args.configId,
          args.adapterId,
          args.date,
          t.sourceId,
          JSON.stringify(t),
          now,
          args.uploadedBy ?? null,
          args.filename ?? null,
        ],
      });
    }

    // Invalidate any completed reco_runs for this (config, date) — uploading
    // new data means whatever the prior run decided is stale. Mark them as
    // 'superseded' so the next workflow run re-processes from scratch.
    // We don't delete prior decisions; they remain under their old runId for
    // historical lookup, but the next run will get a fresh runId and overwrite.
    const invalidated = await tx.execute({
      sql: `UPDATE reco_runs
            SET state = 'superseded', updated_at = ?
            WHERE date = ? AND source = ? AND state = 'completed'`,
      args: [now, args.date, args.configId],
    });

    await tx.commit();
    return {
      count: args.txns.length,
      replaced: Number(prior.rowsAffected ?? 0),
      invalidatedRuns: Number(invalidated.rowsAffected ?? 0),
    };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * Returns the staged rows for one (config, adapter, date) slot, deserialized
 * back to NormalizedTxn[]. Empty array if nothing's been uploaded for that slot.
 */
export async function dbGetStagedTransactions(
  configId: string,
  adapterId: string,
  date: string,
): Promise<NormalizedTxn[]> {
  await ensureSchema();
  const c = getClient();
  const r = await c.execute({
    sql: `SELECT payload FROM reco_staged_transactions
          WHERE config_id = ? AND adapter_id = ? AND date = ?
          ORDER BY id ASC`,
    args: [configId, adapterId, date],
  });
  return r.rows.map(row => JSON.parse(row.payload as string) as NormalizedTxn);
}

/**
 * Lists what's been staged for a given (config, date) — used by the UI to show
 * "you've uploaded 3/4 required sources; still missing 'bank'."
 */
export async function dbListStagedSources(
  configId: string,
  date: string,
): Promise<StagedSourceSummary[]> {
  await ensureSchema();
  const c = getClient();
  const r = await c.execute({
    sql: `SELECT config_id, adapter_id, date,
                 COUNT(*) AS cnt,
                 MAX(uploaded_at) AS uploaded_at,
                 MAX(filename) AS filename
          FROM reco_staged_transactions
          WHERE config_id = ? AND date = ?
          GROUP BY config_id, adapter_id, date
          ORDER BY adapter_id ASC`,
    args: [configId, date],
  });
  return r.rows.map(row => ({
    configId: row.config_id as string,
    adapterId: row.adapter_id as string,
    date: row.date as string,
    count: Number(row.cnt ?? 0),
    uploadedAt: row.uploaded_at as string,
    filename: (row.filename as string | null) ?? null,
  }));
}

/** Hard-delete a slot — used by an admin "clear and re-upload" path. */
export async function dbDeleteStagedSlot(
  configId: string,
  adapterId: string,
  date: string,
): Promise<{ deleted: number }> {
  await ensureSchema();
  const c = getClient();
  const r = await c.execute({
    sql: 'DELETE FROM reco_staged_transactions WHERE config_id = ? AND adapter_id = ? AND date = ?',
    args: [configId, adapterId, date],
  });
  return { deleted: Number(r.rowsAffected ?? 0) };
}

/**
 * Purge ALL staged rows for a (config, date) — every adapter slot.
 *
 * Called after a run's reports are written. Staged rows are parsed copies of
 * the uploaded partner files and carry PII (VPAs, account numbers, names); we
 * don't retain them once the run's deliverables (the two CSV reports) exist.
 * Re-running the same (config, date) therefore requires re-uploading the
 * source files — an accepted trade-off for not holding PII at rest.
 */
export async function dbPurgeStagedForRun(
  configId: string,
  date: string,
): Promise<{ deleted: number }> {
  await ensureSchema();
  const c = getClient();
  const r = await c.execute({
    sql: 'DELETE FROM reco_staged_transactions WHERE config_id = ? AND date = ?',
    args: [configId, date],
  });
  return { deleted: Number(r.rowsAffected ?? 0) };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decisions joined with the staged source + target txn payloads, so the UI
 * can show actual money values per row without a second round-trip.
 *
 * The JOIN chain is:
 *   reco_decisions
 *     → reco_runs            (to recover the run's config + date)
 *     → reco_staged_transactions (twice — once for source, once for target)
 *
 * Both staging joins are LEFT JOINs because a decision can outlive its
 * staging row (the slot might've been cleared after the run). When that
 * happens the amount columns come back null and the UI renders '—'.
 */
export async function dbListRecoDecisions(runId: string, limit?: number): Promise<DBRecoDecisionRow[]> {
  await ensureSchema();
  const c = getClient();
  // Optional LIMIT — settlement runs emit 100k+ decisions; callers that only
  // need a UI sample (OpenArc decisions table) pass a small limit to avoid
  // fetching + serializing the full set. The report-pack builder passes no
  // limit (it needs every row for 08_audit_log.csv).
  const hasLimit = typeof limit === 'number' && limit > 0;
  const r = await c.execute({
    sql: `
      SELECT
        d.run_id, d.source_txn_id, d.target_txn_id, d.match_type,
        d.amount_delta_paise, d.decided_by, d.matcher_version,
        d.reasoning, d.metadata, d.created_at,
        src.payload AS source_payload,
        tgt.payload AS target_payload
      FROM reco_decisions d
      LEFT JOIN reco_runs r ON r.id = d.run_id
      LEFT JOIN reco_staged_transactions src
        ON src.config_id = r.source AND src.date = r.date AND src.source_id = d.source_txn_id
      LEFT JOIN reco_staged_transactions tgt
        ON tgt.config_id = r.source AND tgt.date = r.date AND tgt.source_id = d.target_txn_id
      WHERE d.run_id = ?
      ORDER BY d.id ASC${hasLimit ? ' LIMIT ?' : ''}`,
    args: hasLimit ? [runId, limit] : [runId],
  });

  const parsePayload = (raw: unknown): { amountPaise: number | null; counterparty: string | null } => {
    if (!raw) return { amountPaise: null, counterparty: null };
    try {
      const obj = JSON.parse(raw as string) as NormalizedTxn;
      return {
        amountPaise: typeof obj.amountPaise === 'number' ? obj.amountPaise : null,
        counterparty: obj.counterparty ?? null,
      };
    } catch {
      return { amountPaise: null, counterparty: null };
    }
  };

  const parseMetadata = (raw: unknown): RecoDecision['metadata'] => {
    if (!raw || typeof raw !== 'string') return undefined;
    try {
      return JSON.parse(raw) as RecoDecision['metadata'];
    } catch {
      return undefined;
    }
  };

  return r.rows.map(row => {
    const src = parsePayload(row.source_payload);
    const tgt = parsePayload(row.target_payload);
    return {
      runId: row.run_id as string,
      sourceTxnId: row.source_txn_id as string,
      targetTxnId: (row.target_txn_id as string | null) ?? null,
      matchType: row.match_type as RecoDecision['matchType'],
      amountDeltaPaise: row.amount_delta_paise as number,
      decidedBy: row.decided_by as string,
      matcherVersion: row.matcher_version as string,
      reasoning: (row.reasoning as string | null) ?? undefined,
      metadata: parseMetadata(row.metadata),
      createdAt: row.created_at as string,
      sourceAmountPaise: src.amountPaise,
      targetAmountPaise: tgt.amountPaise,
      sourceCounterparty: src.counterparty,
      targetCounterparty: tgt.counterparty,
    };
  });
}
