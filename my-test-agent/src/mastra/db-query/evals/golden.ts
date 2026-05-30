/**
 * Golden set for the db-query agent — calibrated against the LOCAL OpenArc
 * Postgres (openarc_dashboard_local) as of 2026-05-29.
 *
 * Each case is a natural-language question plus the way we score the answer.
 * Scoring is layered (see scorers.ts); a case may use any combination of —
 *
 *   - referenceSql:  run this SELECT ourselves; the agent's result set must
 *                    match by VALUES (order- and alias-insensitive). Strongest
 *                    signal; preferred mode.
 *   - expectTables:  the agent's `tablesUsed` must include these (schema.table).
 *   - expectConnection: the agent must route to this connection id.
 *   - answerIncludes: case-insensitive substrings the answer must contain.
 *   - expectClarification: true => the agent SHOULD ask for clarification.
 *
 * Re-calibrate after data changes: row counts and category values are
 * data-dependent. The reference SQL is written to be data-independent where
 * possible (it computes the same aggregate the agent should), so it stays
 * valid as rows change — EXCEPT answerIncludes cases, which bake in a value.
 *
 * Schema facts used (abridged):
 *   agent_runs(state, workflow_id, duration_ms, started_at)   state∈{completed,failed}
 *   audit_logs(event_type, severity_level, risk_level, ...)   severity∈{low,medium,high}
 *   cpv_cases(status, case_priority, report_outcome, ...)     status∈{completed,pending,inprogress}
 *   reco_decisions(match_type, decided_by, agent_run_id, ...) 133k rows
 *   modules(name, display_name, category, is_active)          15 rows
 *   roles(name, display_name, is_system_role)                 6 rows
 *   users(name, email, role_id, status)                       4 rows
 *   email_batches(status, total_rows, success_count, ...)     7 rows
 *   email_records(batch_id, status, merchant_email)           21 rows  status∈{sent,failed}
 */

import type { ConnectionId } from '../types.js';

export interface GoldenCase {
  name: string;
  question: string;
  connectionId?: ConnectionId;
  category: 'count' | 'lookup' | 'aggregate' | 'join' | 'ambiguous' | 'routing';

  referenceSql?: string;
  expectTables?: string[];
  expectConnection?: ConnectionId;
  answerIncludes?: string[];
  expectClarification?: boolean;
}

const OPENARC: ConnectionId = 'openarc';

export const GOLDEN_CASES: GoldenCase[] = [
  // ── COUNT ────────────────────────────────────────────────────────────────
  {
    name: 'count-users',
    question: 'How many users are there?',
    connectionId: OPENARC,
    category: 'count',
    referenceSql: `SELECT count(*)::int AS n FROM users`,
    expectTables: ['public.users'],
  },
  {
    name: 'count-failed-email-records',
    question: 'How many email records failed to send?',
    connectionId: OPENARC,
    category: 'count',
    referenceSql: `SELECT count(*)::int AS n FROM email_records WHERE status = 'failed'`,
    expectTables: ['public.email_records'],
  },
  {
    name: 'count-pending-cpv-cases',
    question: 'How many CPV cases are still pending?',
    connectionId: OPENARC,
    category: 'count',
    referenceSql: `SELECT count(*)::int AS n FROM cpv_cases WHERE status = 'pending'`,
    expectTables: ['public.cpv_cases'],
  },
  {
    name: 'count-active-modules',
    question: 'How many active modules are there?',
    connectionId: OPENARC,
    category: 'count',
    referenceSql: `SELECT count(*)::int AS n FROM modules WHERE is_active = true`,
    expectTables: ['public.modules'],
  },

  // ── AGGREGATE (group-by) ───────────────────────────────────────────────────
  {
    name: 'agg-agent-runs-by-state',
    question: 'Break down agent runs by their state.',
    connectionId: OPENARC,
    category: 'aggregate',
    referenceSql: `SELECT state, count(*)::int AS n FROM agent_runs GROUP BY state`,
    expectTables: ['public.agent_runs'],
  },
  {
    name: 'agg-agent-runs-by-workflow',
    question: 'How many agent runs has each workflow had?',
    connectionId: OPENARC,
    category: 'aggregate',
    referenceSql: `SELECT workflow_id, count(*)::int AS n FROM agent_runs GROUP BY workflow_id`,
    expectTables: ['public.agent_runs'],
  },
  {
    name: 'agg-audit-by-severity',
    question: 'How many audit log entries are there at each severity level?',
    connectionId: OPENARC,
    category: 'aggregate',
    referenceSql: `SELECT severity_level, count(*)::int AS n FROM audit_logs GROUP BY severity_level`,
    expectTables: ['public.audit_logs'],
  },
  {
    name: 'agg-cpv-by-outcome',
    question: 'What is the distribution of CPV case report outcomes?',
    connectionId: OPENARC,
    category: 'aggregate',
    referenceSql: `SELECT report_outcome, count(*)::int AS n FROM cpv_cases GROUP BY report_outcome`,
    expectTables: ['public.cpv_cases'],
  },
  {
    name: 'agg-reco-by-match-type',
    question: 'Count the reconciliation decisions by match type.',
    connectionId: OPENARC,
    category: 'aggregate',
    referenceSql: `SELECT match_type, count(*)::int AS n FROM reco_decisions GROUP BY match_type`,
    expectTables: ['public.reco_decisions'],
  },

  // ── LOOKUP ─────────────────────────────────────────────────────────────────
  {
    name: 'lookup-role-names',
    question: 'List all the role names.',
    connectionId: OPENARC,
    category: 'lookup',
    referenceSql: `SELECT name FROM roles`,
    expectTables: ['public.roles'],
  },
  {
    name: 'lookup-module-categories',
    question:
      'Counting all modules regardless of whether they are active, how many modules fall under each category value?',
    connectionId: OPENARC,
    category: 'lookup',
    // Explicit "regardless of active" pins the no-WHERE interpretation; the
    // loose earlier phrasing let the agent sometimes filter is_active=true,
    // producing the same row count with different per-category totals.
    referenceSql: `SELECT category, count(*)::int AS n FROM modules GROUP BY category`,
    expectTables: ['public.modules'],
  },
  {
    name: 'lookup-email-templates',
    question: 'Show me the names of the email templates.',
    connectionId: OPENARC,
    category: 'lookup',
    referenceSql: `SELECT name FROM email_templates`,
    expectTables: ['public.email_templates'],
  },

  // ── JOIN ─────────────────────────────────────────────────────────────────
  {
    name: 'join-users-per-role',
    question:
      'For every role, how many users are assigned to it? Include roles that have zero users, and show the role name.',
    connectionId: OPENARC,
    category: 'join',
    // Question is now explicit about including zero-user roles, which pins the
    // LEFT JOIN interpretation. (The earlier phrasing was genuinely ambiguous
    // — LEFT vs INNER — and the agent legitimately chose INNER. Lesson: an
    // ambiguous question makes an unstable eval case; disambiguate the prompt.)
    referenceSql: `SELECT r.name, count(u.id)::int AS n FROM roles r LEFT JOIN users u ON u.role_id = r.id GROUP BY r.name`,
    expectTables: ['public.roles', 'public.users'],
  },
  {
    name: 'join-email-records-per-batch-status',
    question: 'For each email batch status, how many email records belong to those batches?',
    connectionId: OPENARC,
    category: 'join',
    referenceSql: `SELECT b.status, count(r.id)::int AS n FROM email_batches b JOIN email_records r ON r.batch_id = b.id GROUP BY b.status`,
    expectTables: ['public.email_batches', 'public.email_records'],
  },

  // ── AMBIGUOUS (should ask for clarification) ───────────────────────────────
  {
    name: 'ambiguous-show-logs',
    question: 'Show me the logs.',
    connectionId: OPENARC,
    category: 'ambiguous',
    // Three log tables exist: activity_logs, audit_logs, sql_execution_log.
    // A good agent asks which one rather than guessing.
    expectClarification: true,
  },
  {
    name: 'ambiguous-show-everything',
    question: 'Give me everything important.',
    connectionId: OPENARC,
    category: 'ambiguous',
    expectClarification: true,
  },
];

/** Only the cases that can be objectively scored (referenceSql, clarification, or answerIncludes). */
export function scoredCases(): GoldenCase[] {
  return GOLDEN_CASES.filter(c => c.referenceSql || c.expectClarification || c.answerIncludes?.length);
}
