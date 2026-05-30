/**
 * Zod schemas + type aliases for the db-query subsystem.
 *
 * Everything that crosses a boundary (tool input/output, agent structured
 * output, HTTP route body) goes through these schemas. Per the repo
 * convention, parse at the boundary, trust within.
 *
 * Naming convention: `XSchema` is the Zod schema, `X` is the inferred type.
 */

import { z } from 'zod';

/**
 * Logical connection identifier, set in `connections.ts`. The agent only
 * ever sees / emits this string — actual DSNs never leave the registry.
 */
export const ConnectionIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_-]*$/, 'lowercase alnum/dash/underscore, must start with a letter');
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;

/**
 * `(schema, table)` pair. We always carry both — assuming `public` everywhere
 * breaks on databases that use a real schema layout (e.g. tenant-per-schema).
 */
export const TableRefSchema = z.object({
  schema: z.string().min(1).default('public'),
  table: z.string().min(1),
});
export type TableRef = z.infer<typeof TableRefSchema>;

/**
 * One column as the agent will read it. Most of these are introspected; a few
 * (comment, valuesSeen) are enrichments that materially improve grounding.
 *
 * `valuesSeen` is sampled at cache-build time for low-cardinality text/enum
 * columns. It's the single highest-leverage hint we give the agent —
 * removes a huge class of `status = 'COMPLETED'` vs `'completed'` mistakes.
 */
export const ColumnInfoSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  nullable: z.boolean(),
  isPrimaryKey: z.boolean().default(false),
  foreignKey: z
    .object({
      refSchema: z.string(),
      refTable: z.string(),
      refColumn: z.string(),
    })
    .nullable()
    .default(null),
  indexed: z.boolean().default(false),
  comment: z.string().nullable().default(null),
  /** Up to 12 distinct values for low-cardinality columns; null if not enum-like. */
  valuesSeen: z.array(z.string()).nullable().default(null),
});
export type ColumnInfo = z.infer<typeof ColumnInfoSchema>;

/**
 * Compact table description. Row-count is `pg_class.reltuples` (estimate).
 * The exact count is intentionally not computed — it requires a seq scan on
 * large tables and the agent doesn't need exactness, just order of magnitude.
 */
export const TableInfoSchema = z.object({
  ref: TableRefSchema,
  rowEstimate: z.number().int().nonnegative(),
  columns: z.array(ColumnInfoSchema),
  comment: z.string().nullable().default(null),
  lastRefreshedAt: z.string().describe('ISO-8601 UTC timestamp'),
});
export type TableInfo = z.infer<typeof TableInfoSchema>;

/**
 * Validator verdict. `ok=true` => SQL is safe to execute as-is (possibly
 * after the validator injected a LIMIT — see `effectiveSql`).
 *
 * On `ok=false` the agent reads `reasons` to refine its draft. Reasons are
 * human-grade strings, intentionally not error codes; LLMs handle prose
 * better than they handle code lookups.
 */
export const ValidationResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    effectiveSql: z.string(),
    estimatedCost: z.number().nullable(),
    estimatedRows: z.number().nullable(),
    injectedLimit: z.number().int().positive().nullable(),
    notes: z.array(z.string()).default([]),
  }),
  z.object({
    ok: z.literal(false),
    reasons: z.array(z.string()).min(1),
  }),
]);
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

/**
 * Result envelope returned to the caller (and ultimately the user).
 *
 * `rows` is capped — see runner.ts. `truncated=true` means there were more
 * rows than the cap; the answer should acknowledge that.
 *
 * `piiMasked` lists which columns got redacted so the narrator can mention
 * "(email masked)" instead of silently dropping the column.
 */
export const QueryResultSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  piiMasked: z.array(z.string()).default([]),
  ms: z.number().int().nonnegative(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

/**
 * Top-level workflow input. `connectionId` is optional — if omitted, the
 * router step picks one (or asks for clarification when ambiguous).
 *
 * `priorTurns` carries up to 2 prior (question, sql) pairs for follow-ups.
 * We deliberately keep prior *rows* out of context — they can be huge and
 * the planner only needs the question/SQL shape to do "and break that down
 * by month".
 */
export const DbQueryInputSchema = z.object({
  question: z.string().min(3),
  connectionId: ConnectionIdSchema.optional(),
  priorTurns: z
    .array(
      z.object({
        question: z.string(),
        sql: z.string(),
        connectionId: ConnectionIdSchema,
      }),
    )
    .max(2)
    .default([]),
  requestId: z.string().optional(),
  userId: z.string().optional(),
});
export type DbQueryInput = z.infer<typeof DbQueryInputSchema>;

/** Final workflow output — what callers (and eventually OpenArc) consume. */
export const DbQueryOutputSchema = z.object({
  answer: z.string(),
  sql: z.string(),
  connectionId: ConnectionIdSchema,
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  tablesUsed: z.array(z.string()),
  clarification: z.string().nullable().default(null),
  ms: z.number().int().nonnegative(),
});
export type DbQueryOutput = z.infer<typeof DbQueryOutputSchema>;
