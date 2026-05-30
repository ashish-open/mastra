/**
 * Scorers for the db-query golden set.
 *
 * Three layered checks, each returning a 0..1 score + a human-readable note:
 *
 *   1. resultSetEquality — the gold standard. Runs the case's referenceSql
 *      ourselves and compares the agent's executed rows to it, order-
 *      insensitive and value-normalised. Exact-match SQL is too brittle
 *      (a thousand correct SQLs answer "top 5 agents"), so we compare RESULTS.
 *
 *   2. structuralChecks — cheap deterministic checks on routing + tables used
 *      + clarification behaviour. Used when there's no referenceSql.
 *
 *   3. llmJudge — fallback for narrative answers when we can't compare result
 *      sets (e.g. open-ended questions). An LLM grades whether the answer
 *      plausibly and correctly responds to the question given the rows.
 *
 * Why not exact SQL match: see above. Why result-set equality over "did it
 * run": a query can run and return the WRONG rows. Equality catches that.
 */

import { getConnection } from '../connections.js';
import type { ConnectionId } from '../types.js';
import type { GoldenCase } from './golden.js';

export interface ScoreResult {
  score: number; // 0..1
  note: string;
}

/**
 * Normalise a result set into a canonical string for comparison.
 *
 * Design choice: compare by VALUES, not by column names. Two correct SQLs for
 * "count rows by status" might alias the count as `n`, `count`, or `run_count`
 * — all equally right. Comparing keys would false-fail those. We also coerce
 * numeric strings to numbers (Postgres returns bigint/count as strings, e.g.
 * "50", while a `::int`-cast reference returns 50) and normalise dates.
 *
 * The normalisation, per cell:
 *   - number / bigint            → Number
 *   - numeric-looking string     → Number   ("50" === 50)
 *   - Date                       → ISO string
 *   - other string               → trimmed
 *   - null/undefined             → "∅"
 *
 * Per row: collect the normalised VALUES (ignore keys), sort them, join.
 * Per result set: sort the row-strings (order-insensitive). Two result sets
 * are equal iff their canonical strings match.
 *
 * Trade-off: this can't tell apart two columns whose values were swapped, and
 * it's blind to column naming. For "did the agent fetch the right data?" —
 * the question evals actually care about — that's the right trade.
 */
export function canonicalize(rows: Array<Record<string, unknown>>): string {
  const normVal = (v: unknown): string => {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'number' || typeof v === 'bigint') return String(Number(v));
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') {
      const t = v.trim();
      if (/^-?\d+(\.\d+)?$/.test(t)) return String(Number(t));
      return t;
    }
    return JSON.stringify(v);
  };
  const normRow = (row: Record<string, unknown>): string =>
    Object.values(row).map(normVal).sort().join('|');
  return rows.map(normRow).sort().join('\n');
}

/**
 * Run the reference SQL directly (read-only) and return its rows. Bypasses the
 * validator deliberately — WE wrote this SQL, it's trusted.
 */
async function runReference(connectionId: ConnectionId, sql: string): Promise<Array<Record<string, unknown>>> {
  const conn = getConnection(connectionId);
  const client = await conn.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const res = await client.query<Record<string, unknown>>(sql);
    await client.query('COMMIT');
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * Score result-set equality. `actualRows` come from the workflow's executed
 * query. Returns 1.0 on exact canonical match, else 0 (with a diff note).
 *
 * NOTE: PII masking can legitimately make rows differ from a raw reference.
 * Keep referenceSql free of PII columns (select counts/ids/non-PII fields).
 */
export async function scoreResultSetEquality(
  connectionId: ConnectionId,
  referenceSql: string,
  actualRows: Array<Record<string, unknown>>,
): Promise<ScoreResult> {
  let refRows: Array<Record<string, unknown>>;
  try {
    refRows = await runReference(connectionId, referenceSql);
  } catch (err) {
    return { score: 0, note: `reference SQL failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const refCanon = canonicalize(refRows);
  const actCanon = canonicalize(actualRows);
  if (refCanon === actCanon) {
    return { score: 1, note: `result sets match (${refRows.length} rows)` };
  }
  return {
    score: 0,
    note: `result-set mismatch: reference ${refRows.length} rows vs actual ${actualRows.length} rows`,
  };
}

/**
 * Deterministic structural checks. Returns the AVERAGE of the applicable
 * sub-checks (each 0/1). Skipped checks don't count against the score.
 */
export function scoreStructural(
  caseDef: GoldenCase,
  result: { connectionId: string; tablesUsed: string[]; clarification: string | null; answer: string },
): ScoreResult {
  const checks: Array<{ ok: boolean; label: string }> = [];

  if (caseDef.expectConnection) {
    checks.push({
      ok: result.connectionId === caseDef.expectConnection,
      label: `connection==${caseDef.expectConnection}`,
    });
  }
  if (caseDef.expectTables?.length) {
    const used = new Set(result.tablesUsed.map(t => t.toLowerCase()));
    const missing = caseDef.expectTables.filter(t => !used.has(t.toLowerCase()));
    checks.push({ ok: missing.length === 0, label: missing.length ? `missing tables [${missing.join(', ')}]` : 'tables ok' });
  }
  if (caseDef.expectClarification !== undefined) {
    const asked = result.clarification !== null;
    checks.push({ ok: asked === caseDef.expectClarification, label: `clarification==${caseDef.expectClarification} (got ${asked})` });
  }
  if (caseDef.answerIncludes?.length) {
    const lower = result.answer.toLowerCase();
    const missing = caseDef.answerIncludes.filter(s => !lower.includes(s.toLowerCase()));
    checks.push({ ok: missing.length === 0, label: missing.length ? `answer missing [${missing.join(', ')}]` : 'answer substrings ok' });
  }

  if (checks.length === 0) return { score: 1, note: 'no structural checks' };
  const passed = checks.filter(c => c.ok).length;
  return {
    score: passed / checks.length,
    note: checks.map(c => `${c.ok ? '✓' : '✗'} ${c.label}`).join('; '),
  };
}
