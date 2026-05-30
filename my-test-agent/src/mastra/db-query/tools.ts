/**
 * Mastra tools the planner agent uses to ground itself before drafting SQL.
 *
 * Five tools, deliberately minimal and orthogonal:
 *
 *   1. list-databases      — what connections exist and what's in each
 *   2. list-tables         — tables in one connection (cached)
 *   3. describe-table      — full column / FK / index info for one table
 *   4. sample-rows         — N recent rows (PII-masked) for value inspection
 *   5. search-schema       — fuzzy substring search across cached table+column names
 *
 * Intentional omissions:
 *
 *   - No `run-sql` tool. Execution is a deterministic workflow step *after*
 *     the validator has stamped the SQL. Giving the LLM the ability to
 *     execute its own draft skips the validator and is a footgun.
 *   - No `explain` tool. The validator runs EXPLAIN; surfacing it as a tool
 *     would invite the agent to "tune until cheap", which is rarely useful
 *     and burns tokens.
 *
 * Each tool returns a compact JSON shape — see the schemas inline. Keep the
 * payloads small: the planner runs in a token-tight loop.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { listConnections } from './connections.js';
import { describeTable, listTables, sampleRows } from './introspect.js';
import { isPii, maskValue } from './pii.js';
import { ConnectionIdSchema } from './types.js';

// ─── 1. list-databases ──────────────────────────────────────────────────────

export const listDatabasesTool = createTool({
  id: 'list-databases',
  description:
    'List the database connections this agent can query. Returns id, label, ' +
    'description, and the schemas exposed. Call this FIRST when you do not ' +
    'already know which database holds the data the user is asking about.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    databases: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string(),
        schemas: z.array(z.string()),
      }),
    ),
  }),
  execute: async () => {
    return {
      databases: listConnections().map(c => ({
        id: c.id,
        label: c.label,
        description: c.description,
        schemas: c.allowedSchemas,
      })),
    };
  },
});

// ─── 2. list-tables ─────────────────────────────────────────────────────────

export const listTablesTool = createTool({
  id: 'list-tables',
  description:
    'List tables in one database. Returns schema, table, estimated row count, ' +
    'and any table-level comment. Use this to find candidate tables when you ' +
    'know the database but not the table name. Cached for ~10 minutes.',
  inputSchema: z.object({
    connectionId: ConnectionIdSchema.describe('Database id from list-databases.'),
  }),
  outputSchema: z.object({
    tables: z.array(
      z.object({
        schema: z.string(),
        table: z.string(),
        rowEstimate: z.number(),
        comment: z.string().nullable(),
      }),
    ),
  }),
  execute: async ({ connectionId }) => {
    const tables = await listTables(connectionId);
    return { tables };
  },
});

// ─── 3. describe-table ──────────────────────────────────────────────────────

export const describeTableTool = createTool({
  id: 'describe-table',
  description:
    'Full description of one table: columns (with types, nullability, PK/FK, ' +
    'index flags, comments), low-cardinality column values, row estimate. ' +
    'Call this for every table you intend to join or filter on. Never guess ' +
    'column names — describe first, then write SQL.',
  inputSchema: z.object({
    connectionId: ConnectionIdSchema,
    schema: z.string().default('public'),
    table: z.string(),
  }),
  outputSchema: z.object({
    table: z.string(),
    rowEstimate: z.number(),
    comment: z.string().nullable(),
    columns: z.array(
      z.object({
        name: z.string(),
        type: z.string(),
        nullable: z.boolean(),
        pk: z.boolean(),
        fk: z
          .object({
            refSchema: z.string(),
            refTable: z.string(),
            refColumn: z.string(),
          })
          .nullable(),
        indexed: z.boolean(),
        comment: z.string().nullable(),
        valuesSeen: z.array(z.string()).nullable(),
        pii: z.boolean(),
      }),
    ),
  }),
  execute: async ({ connectionId, schema, table }) => {
    const schemaName = schema ?? 'public';
    const info = await describeTable(connectionId, schemaName, table);
    return {
      table: `${info.ref.schema}.${info.ref.table}`,
      rowEstimate: info.rowEstimate,
      comment: info.comment,
      columns: info.columns.map(c => ({
        name: c.name,
        type: c.dataType,
        nullable: c.nullable,
        pk: c.isPrimaryKey,
        fk: c.foreignKey,
        indexed: c.indexed,
        comment: c.comment,
        valuesSeen: c.valuesSeen,
        pii: isPii(connectionId, info.ref.schema, info.ref.table, c.name).masked,
      })),
    };
  },
});

// ─── 4. sample-rows ─────────────────────────────────────────────────────────

export const sampleRowsTool = createTool({
  id: 'sample-rows',
  description:
    'Fetch up to N (max 20) rows from a table for value inspection. PII columns ' +
    'are masked. Use sparingly — only when describe-table.valuesSeen is null ' +
    'and you genuinely need to see real values to disambiguate.',
  inputSchema: z.object({
    connectionId: ConnectionIdSchema,
    schema: z.string().default('public'),
    table: z.string(),
    n: z.number().int().min(1).max(20).default(5),
  }),
  outputSchema: z.object({
    rows: z.array(z.record(z.string(), z.unknown())),
    piiMasked: z.array(z.string()),
  }),
  execute: async ({ connectionId, schema, table, n }) => {
    const schemaName = schema ?? 'public';
    const sampleN = n ?? 5;
    const rows = await sampleRows(connectionId, schemaName, table, sampleN);
    const piiMasked: string[] = [];
    if (rows.length > 0) {
      const cols = Object.keys(rows[0]);
      for (const col of cols) {
        if (isPii(connectionId, schemaName, table, col).masked) {
          piiMasked.push(col);
          for (const row of rows) row[col] = maskValue(row[col]);
        }
      }
    }
    return { rows, piiMasked: piiMasked.sort() };
  },
});

// ─── 5. search-schema ───────────────────────────────────────────────────────

export const searchSchemaTool = createTool({
  id: 'search-schema',
  description:
    'Fuzzy substring search across cached table names, column names, and ' +
    'comments. Use this first when the user\'s terminology does not obviously ' +
    'map to a table — e.g. "retries" might be column `retry_count` on table ' +
    '`payment_attempts`. Returns top-10 hits with their context.',
  inputSchema: z.object({
    connectionId: ConnectionIdSchema,
    query: z.string().min(2),
  }),
  outputSchema: z.object({
    hits: z.array(
      z.object({
        kind: z.enum(['table', 'column']),
        schema: z.string(),
        table: z.string(),
        column: z.string().nullable(),
        comment: z.string().nullable(),
        score: z.number(),
      }),
    ),
  }),
  execute: async ({ connectionId, query }) => {
    // v1: substring scoring. No embeddings — keeps the dep surface tiny and is
    // surprisingly effective for short queries (5-20 chars). Upgrade to
    // pgvector / sqlite-vss in v2 if eval shows misses.
    const tables = await listTables(connectionId);
    const q = query.toLowerCase();
    const hits: Array<{
      kind: 'table' | 'column';
      schema: string;
      table: string;
      column: string | null;
      comment: string | null;
      score: number;
    }> = [];

    for (const t of tables) {
      const tableScore = substringScore(q, t.table) + (t.comment ? 0.5 * substringScore(q, t.comment) : 0);
      if (tableScore > 0) {
        hits.push({ kind: 'table', schema: t.schema, table: t.table, column: null, comment: t.comment, score: tableScore });
      }
    }

    // Column hits require describing each table — expensive. To keep this
    // fast, only descend into tables that already produced a non-trivial
    // table-name hit, OR limit to the first 30 tables. This is a heuristic;
    // tune as eval surfaces misses.
    const tablesToDescribe = (
      hits.length > 0 ? hits.slice(0, 10).map(h => ({ schema: h.schema, table: h.table })) : tables.slice(0, 30)
    );
    await Promise.all(
      tablesToDescribe.map(async t => {
        try {
          const info = await describeTable(connectionId, t.schema, t.table);
          for (const c of info.columns) {
            const colScore = substringScore(q, c.name) + (c.comment ? 0.5 * substringScore(q, c.comment) : 0);
            if (colScore > 0) {
              hits.push({
                kind: 'column',
                schema: info.ref.schema,
                table: info.ref.table,
                column: c.name,
                comment: c.comment,
                score: colScore,
              });
            }
          }
        } catch {
          // Skip tables we can't describe (e.g. permission denied on a system view).
        }
      }),
    );

    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, 10) };
  },
});

/**
 * Cheap substring score: 0 if no match, otherwise (matchLen / haystackLen)
 * with a small boost for prefix matches and exact word boundaries. Returns 0-2.
 */
function substringScore(query: string, haystack: string): number {
  const h = haystack.toLowerCase();
  const idx = h.indexOf(query);
  if (idx === -1) return 0;
  const base = query.length / h.length;
  const prefixBoost = idx === 0 ? 0.3 : 0;
  const wordBoundaryBoost = idx === 0 || /[\s_-]/.test(h[idx - 1] ?? '') ? 0.2 : 0;
  return base + prefixBoost + wordBoundaryBoost;
}

/** Convenience: every tool keyed by id, ready to spread into an Agent's `tools`. */
export const dbQueryTools = {
  'list-databases': listDatabasesTool,
  'list-tables': listTablesTool,
  'describe-table': describeTableTool,
  'sample-rows': sampleRowsTool,
  'search-schema': searchSchemaTool,
};
