/**
 * Validator — the gate every LLM-drafted SQL must pass before execution.
 *
 * Layered defense (each layer is independently sufficient for *most* cases;
 * together they cover the rest):
 *
 *   1. Statement-level regex pre-filter. Cheap reject for obvious writes
 *      (INSERT/UPDATE/DELETE/MERGE/TRUNCATE/DROP/CREATE/ALTER/GRANT/REVOKE/
 *      COPY/VACUUM/ANALYZE/LOCK/SET/CALL/DO/COMMENT) and multi-statement
 *      submissions (semicolons outside literals).
 *
 *   2. Required-shape check. Top-level statement must be SELECT or
 *      (WITH ... SELECT). Anything else is rejected with a helpful reason.
 *
 *   3. LIMIT injection. If the SQL has no LIMIT and no aggregate-only top-
 *      level projection, we inject `LIMIT <ROW_CAP>`. Aggregate-only is
 *      detected with a permissive regex on the outer SELECT list — if we
 *      can't tell, we err on the side of injecting.
 *
 *   4. EXPLAIN cost+rows gate. We run `EXPLAIN (FORMAT JSON)` in the target
 *      DB. If the planner's row estimate or total cost exceeds thresholds,
 *      the query is rejected with the numbers so the agent can refine
 *      (add a WHERE, drop a join, etc.).
 *
 *   5. Postgres-side read-only role + `default_transaction_read_only=on`
 *      (set in `connections.ts`). This is the real safety net — even if 1-4
 *      were all bypassed, the role can't write.
 *
 * The validator never executes the user's query. It only runs EXPLAIN.
 */

import { getConnection } from './connections.js';
import type { ConnectionId, ValidationResult } from './types.js';

const ROW_CAP = Number(process.env.DB_QUERY_ROW_CAP ?? 1_000);
const EXPLAIN_ROW_CAP = Number(process.env.DB_QUERY_EXPLAIN_ROW_CAP ?? 5_000_000);
const EXPLAIN_COST_CAP = Number(process.env.DB_QUERY_EXPLAIN_COST_CAP ?? 50_000_000);

/** Tokens that flag a write or DDL statement at the start of any line. */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE|COPY|VACUUM|ANALYZE|LOCK|REINDEX|REFRESH|CLUSTER|CALL|DO|COMMENT|SECURITY\s+LABEL|SET\b(?!\s+TRANSACTION\s+READ\s+ONLY)|RESET)\b/i;

const FOR_UPDATE = /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i;

/**
 * Strip SQL comments (`--`, `/* ... *\/`) and single-quoted string literals
 * to make subsequent keyword/semicolon checks safe. Returns the scrubbed SQL.
 *
 * Note: we don't try to perfectly preserve structure; we just blank out the
 * masked regions with spaces of equal length so the regex line/col offsets
 * still roughly line up if we ever want to surface them.
 */
function scrub(sql: string): string {
  let out = sql;
  // Line comments
  out = out.replace(/--[^\n]*/g, m => ' '.repeat(m.length));
  // Block comments (non-nesting; Postgres allows nesting but it's rare and we
  // err on the side of false-rejecting which the agent can recover from).
  out = out.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
  // Single-quoted strings (double '' escapes are tolerated by the regex)
  out = out.replace(/'(?:''|[^'])*'/g, m => "'" + ' '.repeat(m.length - 2) + "'");
  // Dollar-quoted strings: $tag$ ... $tag$
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, m => ' '.repeat(m.length));
  return out;
}

/**
 * Heuristic: does the top-level SELECT list contain ONLY aggregate
 * expressions / constants? If yes, we skip LIMIT injection (the result is
 * already a fixed-size summary row).
 */
function isAggregateOnly(scrubbed: string): boolean {
  // Pull the outermost SELECT ... FROM block.
  const m = scrubbed.match(/SELECT\s+([\s\S]*?)\s+FROM\s/i);
  if (!m) return false;
  const list = m[1];
  // If there's a GROUP BY anywhere, the result is per-group → not fixed-size.
  if (/\bGROUP\s+BY\b/i.test(scrubbed)) return false;
  // If every comma-separated piece is wrapped in an aggregate or is a literal,
  // we call it aggregate-only.
  const pieces = splitTopLevel(list, ',');
  return pieces.every(p =>
    /^\s*(COUNT|SUM|AVG|MIN|MAX|ARRAY_AGG|JSON_AGG|JSONB_AGG|STRING_AGG|BIT_AND|BIT_OR|BOOL_AND|BOOL_OR|EVERY|PERCENTILE_CONT|PERCENTILE_DISC)\s*\(/i.test(p) ||
      /^\s*[0-9'TRUEFALSNULL.\-+]/i.test(p),
  );
}

/** Split on a delimiter, respecting nested parentheses. */
function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === delim && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** True if scrubbed SQL already contains a LIMIT at the top level. */
function hasTopLevelLimit(scrubbed: string): boolean {
  // Find outermost `LIMIT n` not inside parens.
  let depth = 0;
  const lower = scrubbed.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && lower.startsWith('limit', i) && /[\s)]/.test(lower[i - 1] ?? ' ')) {
      // Ensure 'limit' is bounded by whitespace
      if (/[\s\d]/.test(lower[i + 5] ?? '')) return true;
    }
  }
  return false;
}

/**
 * Run validation. Returns a discriminated `ValidationResult`. On success the
 * caller should execute `effectiveSql` (which may have a LIMIT injected).
 *
 * `requireSelectOnly` defaults to true. If set false (currently no callers),
 * the regex/shape checks are relaxed — kept as a parameter for future
 * write-with-approval support.
 */
export async function validateSql(
  connectionId: ConnectionId,
  rawSql: string,
  opts: { requireSelectOnly?: boolean } = {},
): Promise<ValidationResult> {
  const requireSelectOnly = opts.requireSelectOnly ?? true;
  const reasons: string[] = [];

  const sql = rawSql.trim().replace(/;\s*$/, '');
  if (!sql) return { ok: false, reasons: ['Empty SQL.'] };

  const scrubbed = scrub(sql);

  // (1) Multi-statement check — semicolon in the scrubbed body means a second statement.
  if (scrubbed.includes(';')) {
    reasons.push('Multiple statements detected. Submit a single SELECT.');
  }

  // (2) Write/DDL keywords
  if (requireSelectOnly && WRITE_KEYWORDS.test(scrubbed)) {
    const m = scrubbed.match(WRITE_KEYWORDS);
    reasons.push(`Disallowed keyword '${m?.[0]}'. This agent is read-only — SELECT only.`);
  }

  // (3) Locking clauses — disallowed even for SELECT
  if (FOR_UPDATE.test(scrubbed)) {
    reasons.push('Locking clauses (FOR UPDATE/SHARE) are not allowed. Drop the clause.');
  }

  // (4) Required shape: outermost statement is SELECT (or WITH ... SELECT).
  if (requireSelectOnly) {
    const head = scrubbed.replace(/^\s+/, '').slice(0, 10).toUpperCase();
    if (!head.startsWith('SELECT') && !head.startsWith('WITH')) {
      reasons.push(`Top-level statement must be SELECT or WITH ... SELECT. Got: '${head.trim()}'.`);
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };

  // (5) LIMIT injection
  let effectiveSql = sql;
  let injectedLimit: number | null = null;
  if (!hasTopLevelLimit(scrubbed) && !isAggregateOnly(scrubbed)) {
    effectiveSql = `${sql}\nLIMIT ${ROW_CAP}`;
    injectedLimit = ROW_CAP;
  }

  // (6) EXPLAIN cost gate. We run EXPLAIN with FORMAT JSON and parse the
  //     top-level plan node. ANALYZE is intentionally NOT used (it would
  //     execute the query).
  let estimatedCost: number | null = null;
  let estimatedRows: number | null = null;
  const notes: string[] = [];
  try {
    const conn = getConnection(connectionId);
    const res = await conn.pool.query(`EXPLAIN (FORMAT JSON) ${effectiveSql}`);
    const planRow = res.rows[0]?.['QUERY PLAN'];
    const plan = Array.isArray(planRow) ? planRow[0]?.Plan : planRow?.[0]?.Plan;
    if (plan) {
      estimatedCost = Number(plan['Total Cost'] ?? null);
      estimatedRows = Number(plan['Plan Rows'] ?? null);
    }
  } catch (err) {
    return {
      ok: false,
      reasons: [
        `EXPLAIN failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `The SQL may reference an unknown table/column, or have a syntax error.`,
      ],
    };
  }

  if (estimatedRows !== null && estimatedRows > EXPLAIN_ROW_CAP) {
    return {
      ok: false,
      reasons: [
        `Estimated row count ${estimatedRows.toLocaleString()} exceeds cap ${EXPLAIN_ROW_CAP.toLocaleString()}. ` +
          `Add a WHERE clause to narrow the result, or aggregate.`,
      ],
    };
  }
  if (estimatedCost !== null && estimatedCost > EXPLAIN_COST_CAP) {
    return {
      ok: false,
      reasons: [
        `Estimated cost ${estimatedCost.toLocaleString()} exceeds cap ${EXPLAIN_COST_CAP.toLocaleString()}. ` +
          `Likely a missing index or unbounded join — refine the query.`,
      ],
    };
  }

  if (injectedLimit) notes.push(`Injected LIMIT ${injectedLimit} (no explicit LIMIT, not aggregate-only).`);

  return {
    ok: true,
    effectiveSql,
    estimatedCost,
    estimatedRows,
    injectedLimit,
    notes,
  };
}
