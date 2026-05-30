/**
 * Named Postgres connection registry for the db-query agent.
 *
 * Purpose:
 *
 *   The agent never sees a DSN. It picks from a small, curated list of
 *   logical connection IDs (e.g. `openarc`, `reco_yes`). This file is the
 *   ONLY place that maps an ID to a real DSN, and the only place that
 *   constructs pg pools.
 *
 * Safety contract — every pool created here:
 *
 *   1. Uses a `default_transaction_read_only = on` session setting via
 *      `application_name` + a per-connection `SET` on checkout. Even if a
 *      bug ever slipped through the validator, the session refuses writes.
 *   2. Sets `statement_timeout = 15s` so a runaway query gets killed.
 *   3. Sets `idle_in_transaction_session_timeout = 5s` so a stuck client
 *      doesn't hold a connection forever.
 *   4. Is expected to authenticate as a READ-ONLY Postgres role with
 *      `GRANT SELECT` only on the schemas you want exposed. That's the
 *      real safety net — everything above is defense-in-depth.
 *
 * Config:
 *
 *   Connections are registered via `registerConnection()` at app startup
 *   (see index.ts wiring). Each connection reads its DSN from env so we
 *   don't commit secrets. If the env var is unset we skip registration and
 *   log a warning — a missing DSN must never crash the dev server, since
 *   only some connections are configured in any given environment.
 *
 * Naming:
 *
 *   IDs follow `^[a-z][a-z0-9_-]*$`. Prefer short, descriptive names
 *   (`openarc`, `reco_yes`, `reco_internal`) over branded ones.
 */

import pg from 'pg';
import { ConnectionIdSchema, type ConnectionId } from './types.js';

/** Registry entry — what we keep per logical connection. */
interface ConnectionEntry {
  id: ConnectionId;
  /** Short human-readable label — surfaced to the agent via `list_databases`. */
  label: string;
  /** Free-text description; what kind of data lives here. The agent uses this for routing. */
  description: string;
  /** Schemas the agent is allowed to introspect / query. */
  allowedSchemas: string[];
  pool: pg.Pool;
}

const registry = new Map<ConnectionId, ConnectionEntry>();

/**
 * Options for `registerConnection`. `dsn` is read by the caller from env so
 * this module never touches `process.env` directly — keeps it test-friendly.
 */
export interface RegisterConnectionOptions {
  id: string;
  label: string;
  description: string;
  /** Postgres DSN. If `null`/`undefined`, the registration is skipped (warning logged). */
  dsn: string | null | undefined;
  /** Defaults to `['public']`. Listed here as a safety hint — the RO role is the real gate. */
  allowedSchemas?: string[];
  /** Default 15_000ms. */
  statementTimeoutMs?: number;
  /** Default 5_000ms. */
  idleTxTimeoutMs?: number;
  /** Default 5 — keep small; this agent's traffic is bursty, not high-QPS. */
  maxPoolSize?: number;
}

/**
 * Register a logical connection. Idempotent — re-registering the same id
 * is a no-op with a warning (avoids surprise behaviour when `index.ts` is
 * hot-reloaded by `mastra dev`).
 *
 * @returns `true` if registered, `false` if skipped (missing DSN) or duplicate.
 */
export function registerConnection(opts: RegisterConnectionOptions): boolean {
  const id = ConnectionIdSchema.parse(opts.id);

  if (registry.has(id)) {
    // Don't tear down an existing pool — hot reload would otherwise drop
    // active queries. Just keep what we have.
    console.warn(`[db-query] connection '${id}' already registered; skipping re-registration`);
    return false;
  }

  if (!opts.dsn) {
    console.warn(
      `[db-query] connection '${id}' has no DSN configured — skipping registration. ` +
        `Set the corresponding env var to enable.`,
    );
    return false;
  }

  const pool = new pg.Pool({
    connectionString: opts.dsn,
    application_name: `mastra-db-query:${id}`,
    max: opts.maxPoolSize ?? 5,
    idleTimeoutMillis: 30_000,
    // statement_timeout / idle_in_transaction_session_timeout are session
    // variables — pg's `options` connection param applies them at connect time
    // for every backend, so we don't need per-checkout SET round-trips.
    options:
      `-c statement_timeout=${opts.statementTimeoutMs ?? 15_000} ` +
      `-c idle_in_transaction_session_timeout=${opts.idleTxTimeoutMs ?? 5_000} ` +
      `-c default_transaction_read_only=on`,
  });

  pool.on('error', err => {
    // Pool-level errors (e.g. idle client disconnects) — log, don't crash.
    console.warn(`[db-query] pool '${id}' error:`, err.message);
  });

  registry.set(id, {
    id,
    label: opts.label,
    description: opts.description,
    allowedSchemas: opts.allowedSchemas ?? ['public'],
    pool,
  });

  console.log(`[db-query] connection '${id}' registered (schemas: ${(opts.allowedSchemas ?? ['public']).join(', ')})`);
  return true;
}

/** All registered connections in a stable order (alphabetical by id). */
export function listConnections(): Array<{
  id: ConnectionId;
  label: string;
  description: string;
  allowedSchemas: string[];
}> {
  return [...registry.values()]
    .map(({ id, label, description, allowedSchemas }) => ({ id, label, description, allowedSchemas }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Lookup a connection entry. Throws a descriptive error if missing — never returns undefined. */
export function getConnection(id: ConnectionId): ConnectionEntry {
  const entry = registry.get(id);
  if (!entry) {
    const available = [...registry.keys()].sort().join(', ') || '(none)';
    throw new Error(
      `db-query: unknown connection '${id}'. Available: ${available}. ` +
        `Check spelling, or register the connection in index.ts.`,
    );
  }
  return entry;
}

/** Cleanly shut down all pools — call from a `process.on('SIGTERM')` if you wire one up. */
export async function closeAllConnections(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  await Promise.all(
    entries.map(async e => {
      try {
        await e.pool.end();
      } catch (err) {
        console.warn(`[db-query] closing pool '${e.id}' failed:`, err instanceof Error ? err.message : err);
      }
    }),
  );
}
