/**
 * LibSQL-backed cache of Postgres table/column metadata for the db-query agent.
 *
 * Why cache:
 *
 *   The agent calls `describe_table` and `list_tables` repeatedly across a
 *   single question (and across multiple questions in a session). Each
 *   introspection query hits `pg_catalog` / `information_schema` — cheap,
 *   but a >100ms round trip on remote Postgres adds up across a 5-step
 *   reasoning loop. The cache turns those into local sub-ms reads.
 *
 * Storage:
 *
 *   LibSQL at DB_QUERY_DB_URL (default `file:./db-query.db`), kept separate
 *   from `reco.db` so reco's schema migrations don't touch this one. Two
 *   tables:
 *
 *     dbq_table_cache(connection_id, schema, table, payload_json, refreshed_at)
 *       payload_json is the serialised `TableInfo`.
 *
 *     dbq_table_list(connection_id, refreshed_at, payload_json)
 *       Cached list_tables response for the whole connection. Singleton row
 *       per connection_id.
 *
 * TTL:
 *
 *   10 minutes (DB_QUERY_CACHE_TTL_MS env override). On TTL miss, the
 *   caller refreshes from Postgres and writes back. There is also a manual
 *   `invalidateConnection()` for post-migration refresh.
 *
 * Concurrency:
 *
 *   No locks. If two requests miss the same key, both refresh and the last
 *   writer wins. The data is idempotent (same payload from pg_catalog), so
 *   the race is harmless.
 */

import { createClient, type Client } from '@libsql/client';
import { TableInfoSchema, type ConnectionId, type TableInfo } from './types.js';

const DB_URL = process.env.DB_QUERY_DB_URL ?? 'file:./db-query.db';
const TTL_MS = Number(process.env.DB_QUERY_CACHE_TTL_MS ?? 10 * 60 * 1000);

let _client: Client | null = null;
let _schemaReady: Promise<void> | null = null;

function getClient(): Client {
  if (!_client) _client = createClient({ url: DB_URL });
  return _client;
}

/**
 * Idempotent schema bootstrap. Called by every public function on first use.
 */
async function ensureSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const c = getClient();
    await c.executeMultiple(`
      CREATE TABLE IF NOT EXISTS dbq_table_cache (
        connection_id TEXT NOT NULL,
        schema_name   TEXT NOT NULL,
        table_name    TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        refreshed_at  TEXT NOT NULL,
        PRIMARY KEY (connection_id, schema_name, table_name)
      );

      CREATE TABLE IF NOT EXISTS dbq_table_list (
        connection_id TEXT PRIMARY KEY,
        payload_json  TEXT NOT NULL,
        refreshed_at  TEXT NOT NULL
      );
    `);
  })();
  return _schemaReady;
}

/** A single cached table entry as returned to the rest of the subsystem. */
export interface CachedTable {
  info: TableInfo;
  /** Seconds since the row was refreshed — useful for logs. */
  ageMs: number;
}

/**
 * Read a cached `TableInfo`. Returns `null` on miss OR on stale (older than TTL).
 * Callers should treat both the same way: refresh from Postgres, then `putTable`.
 */
export async function getCachedTable(
  connectionId: ConnectionId,
  schema: string,
  table: string,
): Promise<CachedTable | null> {
  await ensureSchema();
  const c = getClient();
  const rs = await c.execute({
    sql: `SELECT payload_json, refreshed_at FROM dbq_table_cache
          WHERE connection_id = ? AND schema_name = ? AND table_name = ?`,
    args: [connectionId, schema, table],
  });
  const row = rs.rows[0];
  if (!row) return null;

  const refreshedAt = new Date(String(row.refreshed_at)).getTime();
  const ageMs = Date.now() - refreshedAt;
  if (ageMs > TTL_MS) return null;

  // We trust what we wrote, but parse-on-read defensively in case the schema
  // shape evolves and a stale row gets shaped wrong.
  try {
    const info = TableInfoSchema.parse(JSON.parse(String(row.payload_json)));
    return { info, ageMs };
  } catch {
    // Treat as a miss — the caller will refresh and overwrite.
    return null;
  }
}

/** Upsert a `TableInfo` payload into the cache. */
export async function putCachedTable(connectionId: ConnectionId, info: TableInfo): Promise<void> {
  await ensureSchema();
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO dbq_table_cache
            (connection_id, schema_name, table_name, payload_json, refreshed_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(connection_id, schema_name, table_name)
          DO UPDATE SET payload_json = excluded.payload_json,
                        refreshed_at = excluded.refreshed_at`,
    args: [connectionId, info.ref.schema, info.ref.table, JSON.stringify(info), info.lastRefreshedAt],
  });
}

/** Cached list of (schema, table, rowEstimate, comment) for a whole connection. */
export interface TableListEntry {
  schema: string;
  table: string;
  rowEstimate: number;
  comment: string | null;
}

export async function getCachedTableList(connectionId: ConnectionId): Promise<TableListEntry[] | null> {
  await ensureSchema();
  const c = getClient();
  const rs = await c.execute({
    sql: `SELECT payload_json, refreshed_at FROM dbq_table_list WHERE connection_id = ?`,
    args: [connectionId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  const ageMs = Date.now() - new Date(String(row.refreshed_at)).getTime();
  if (ageMs > TTL_MS) return null;
  try {
    return JSON.parse(String(row.payload_json)) as TableListEntry[];
  } catch {
    return null;
  }
}

export async function putCachedTableList(
  connectionId: ConnectionId,
  entries: TableListEntry[],
): Promise<void> {
  await ensureSchema();
  const c = getClient();
  await c.execute({
    sql: `INSERT INTO dbq_table_list (connection_id, payload_json, refreshed_at)
          VALUES (?, ?, ?)
          ON CONFLICT(connection_id) DO UPDATE
          SET payload_json = excluded.payload_json,
              refreshed_at = excluded.refreshed_at`,
    args: [connectionId, JSON.stringify(entries), new Date().toISOString()],
  });
}

/**
 * Force-drop everything we know about a connection. Call after a migration
 * lands in the target DB and you need fresh schema introspection.
 */
export async function invalidateConnection(connectionId: ConnectionId): Promise<void> {
  await ensureSchema();
  const c = getClient();
  await c.batch(
    [
      { sql: `DELETE FROM dbq_table_cache WHERE connection_id = ?`, args: [connectionId] },
      { sql: `DELETE FROM dbq_table_list  WHERE connection_id = ?`, args: [connectionId] },
    ],
    'write',
  );
}
