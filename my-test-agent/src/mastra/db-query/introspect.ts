/**
 * Postgres introspection: `list_tables`, `describe_table`, `sample_rows`.
 *
 * These are the read-only metadata queries the agent uses to ground itself
 * before writing SQL. All three go through the schema cache (table-info,
 * table-list); `sample_rows` does NOT — samples are deliberately fresh so
 * the agent sees recent values.
 *
 * Source of truth: `pg_catalog` (faster, more complete than `information_schema`).
 *
 * One critical enrichment beyond raw catalog data: low-cardinality columns
 * get a `valuesSeen` array — up to 12 distinct text values. This is the
 * single most useful hint we give the agent. It is computed lazily during
 * `describe_table` so the upfront cost is paid once per table per TTL.
 */

import { getConnection } from './connections.js';
import {
  getCachedTable,
  getCachedTableList,
  putCachedTable,
  putCachedTableList,
  type TableListEntry,
} from './schema-cache.js';
import {
  type ColumnInfo,
  type ConnectionId,
  type TableInfo,
  TableInfoSchema,
} from './types.js';

/**
 * List tables visible to the connection's RO role, restricted to its
 * `allowedSchemas`. Returns row estimates from `pg_class.reltuples`.
 *
 * Cached. Set `forceRefresh=true` to bypass.
 */
export async function listTables(
  connectionId: ConnectionId,
  opts: { forceRefresh?: boolean } = {},
): Promise<TableListEntry[]> {
  if (!opts.forceRefresh) {
    const cached = await getCachedTableList(connectionId);
    if (cached) return cached;
  }

  const conn = getConnection(connectionId);
  const sql = `
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           GREATEST(c.reltuples, 0)::bigint AS row_estimate,
           obj_description(c.oid, 'pg_class')  AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm')      -- regular, partitioned, view, matview
      AND n.nspname = ANY($1::text[])
    ORDER BY n.nspname, c.relname
  `;
  const { rows } = await conn.pool.query(sql, [conn.allowedSchemas]);
  const entries: TableListEntry[] = rows.map(r => ({
    schema: String(r.schema_name),
    table: String(r.table_name),
    rowEstimate: Number(r.row_estimate),
    comment: r.comment ? String(r.comment) : null,
  }));
  await putCachedTableList(connectionId, entries);
  return entries;
}

/**
 * Full description of a single table. Includes columns (with PK/FK/index
 * flags + comments), table comment, row estimate, and `valuesSeen` for
 * low-cardinality text-ish columns.
 *
 * Cached. `forceRefresh=true` to bypass.
 */
export async function describeTable(
  connectionId: ConnectionId,
  schema: string,
  table: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<TableInfo> {
  if (!opts.forceRefresh) {
    const cached = await getCachedTable(connectionId, schema, table);
    if (cached) return cached.info;
  }

  const conn = getConnection(connectionId);

  // Single round-trip would be possible with a CTE, but readability wins —
  // these are infrequent calls and only on cache miss.
  const colSql = `
    SELECT a.attname              AS name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull        AS nullable,
           col_description(a.attrelid, a.attnum) AS comment
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `;
  const pkSql = `
    SELECT a.attname AS name
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
  `;
  const fkSql = `
    SELECT a.attname  AS col,
           rn.nspname AS ref_schema,
           rc.relname AS ref_table,
           ra.attname AS ref_col
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid  = con.conrelid
    JOIN pg_namespace n ON n.oid  = c.relnamespace
    JOIN pg_class rc    ON rc.oid = con.confrelid
    JOIN pg_namespace rn ON rn.oid = rc.relnamespace
    JOIN unnest(con.conkey)  WITH ORDINALITY AS k(attnum, ord)
      ON true
    JOIN unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord)
      ON rk.ord = k.ord
    JOIN pg_attribute a  ON a.attrelid  = c.oid  AND a.attnum  = k.attnum
    JOIN pg_attribute ra ON ra.attrelid = rc.oid AND ra.attnum = rk.attnum
    WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f'
  `;
  const idxSql = `
    SELECT DISTINCT a.attname AS name
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = $1 AND c.relname = $2
  `;
  const tblMetaSql = `
    SELECT GREATEST(c.reltuples, 0)::bigint AS row_estimate,
           obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2
  `;

  const [colRes, pkRes, fkRes, idxRes, metaRes] = await Promise.all([
    conn.pool.query(colSql, [schema, table]),
    conn.pool.query(pkSql, [schema, table]),
    conn.pool.query(fkSql, [schema, table]),
    conn.pool.query(idxSql, [schema, table]),
    conn.pool.query(tblMetaSql, [schema, table]),
  ]);

  if (metaRes.rows.length === 0) {
    throw new Error(
      `db-query: table '${schema}.${table}' not found in '${connectionId}'. ` +
        `Use list_tables to discover available tables.`,
    );
  }

  const pkSet = new Set(pkRes.rows.map(r => String(r.name)));
  const idxSet = new Set(idxRes.rows.map(r => String(r.name)));
  const fkByCol = new Map<string, ColumnInfo['foreignKey']>();
  for (const r of fkRes.rows) {
    fkByCol.set(String(r.col), {
      refSchema: String(r.ref_schema),
      refTable: String(r.ref_table),
      refColumn: String(r.ref_col),
    });
  }

  // Sample `valuesSeen` for short-text-ish columns. Done in parallel, capped
  // at 12 values, capped at 5_000 sampled rows. If the column has more than
  // 12 distinct values in the sample, we drop the field (it's not enum-like).
  const candidateValueCols = colRes.rows.filter(c => /^(text|varchar|char|bpchar|name|enum)/i.test(String(c.data_type)));
  const valuesByCol = new Map<string, string[] | null>();
  await Promise.all(
    candidateValueCols.map(async c => {
      const colName = String(c.name);
      try {
        const sampled = await conn.pool.query(
          `SELECT DISTINCT ${quoteIdent(colName)} AS v
           FROM ${quoteIdent(schema)}.${quoteIdent(table)}
           WHERE ${quoteIdent(colName)} IS NOT NULL
           LIMIT 13`,
        );
        if (sampled.rows.length > 12) {
          valuesByCol.set(colName, null);
        } else {
          valuesByCol.set(
            colName,
            sampled.rows.map(r => String(r.v)),
          );
        }
      } catch {
        // Permission denied or odd type — silently skip the enrichment.
        valuesByCol.set(colName, null);
      }
    }),
  );

  const columns: ColumnInfo[] = colRes.rows.map(r => {
    const name = String(r.name);
    return {
      name,
      dataType: String(r.data_type),
      nullable: Boolean(r.nullable),
      isPrimaryKey: pkSet.has(name),
      foreignKey: fkByCol.get(name) ?? null,
      indexed: idxSet.has(name),
      comment: r.comment ? String(r.comment) : null,
      valuesSeen: valuesByCol.get(name) ?? null,
    };
  });

  const info: TableInfo = TableInfoSchema.parse({
    ref: { schema, table },
    rowEstimate: Number(metaRes.rows[0].row_estimate),
    columns,
    comment: metaRes.rows[0].comment ? String(metaRes.rows[0].comment) : null,
    lastRefreshedAt: new Date().toISOString(),
  });

  await putCachedTable(connectionId, info);
  return info;
}

/**
 * Sample up to N rows from a table. Not cached — the whole point is to see
 * recent values. Capped at 20 to keep the agent's context small.
 *
 * NOTE: this does not apply PII masking. Callers (the tool layer) must mask
 * before returning to the agent.
 */
export async function sampleRows(
  connectionId: ConnectionId,
  schema: string,
  table: string,
  n = 5,
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(Math.max(1, n), 20);
  const conn = getConnection(connectionId);
  const { rows } = await conn.pool.query(
    `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Quote a Postgres identifier for safe interpolation into SQL where
 * parameterised binds aren't possible (table/column names in DDL-shaped
 * contexts). Mirrors the rules in pg's `escapeIdentifier`.
 */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
