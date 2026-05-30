/**
 * Connection bootstrap — registers the db-query Postgres connections at app
 * startup from environment variables.
 *
 * Called once from index.ts. Idempotent (registerConnection guards against
 * duplicate ids), so a hot-reload under `mastra dev` is harmless.
 *
 * Each connection is gated behind its env var: if the DSN is unset, the
 * connection is silently skipped (a warning is logged inside
 * registerConnection). This means the dev server boots fine even when only
 * some databases are configured.
 *
 * IMPORTANT: the DSN must authenticate as a READ-ONLY Postgres role. See
 * connections.ts for the full safety contract. Create the role with:
 *
 *   CREATE ROLE agent_ro LOGIN PASSWORD '...';
 *   GRANT CONNECT ON DATABASE openarc TO agent_ro;
 *   GRANT USAGE ON SCHEMA public TO agent_ro;
 *   GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_ro;
 *   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO agent_ro;
 *
 * Then point OPENARC_DB_RO_URL at it:
 *   OPENARC_DB_RO_URL=postgres://agent_ro:...@host:5432/openarc
 */

import { registerConnection } from './connections.js';

/** Register all configured db-query connections. Returns how many were registered. */
export function registerDbQueryConnections(): number {
  let count = 0;

  // OpenArc dashboard Postgres — modules, agents, runs, etc.
  if (
    registerConnection({
      id: 'openarc',
      label: 'OpenArc Dashboard',
      description:
        'OpenArc operations dashboard database: modules, permissions, AI-agent ' +
        'runs, reconciliation mirror tables, users, and audit logs.',
      dsn: process.env.OPENARC_DB_RO_URL,
      allowedSchemas: (process.env.OPENARC_DB_SCHEMAS ?? 'public').split(',').map(s => s.trim()),
    })
  ) {
    count++;
  }

  if (count === 0) {
    console.warn(
      '[db-query] no connections registered — set OPENARC_DB_RO_URL (read-only role) to enable the DB query agent.',
    );
  }
  return count;
}
