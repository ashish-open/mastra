/**
 * dbQueryWorkflow — natural-language question → answer sourced from Postgres.
 *
 * Steps (each independently testable):
 *
 *   1. planStep
 *      Invokes the planner agent. The agent uses tools (list-databases,
 *      list-tables, describe-table, sample-rows, search-schema) to ground
 *      itself, then returns { sql, connectionId, tablesUsed, reasoning,
 *      needsClarification }.
 *
 *   2. validateStep
 *      If the planner asked for clarification, short-circuit straight to
 *      `narrateStep` with a 0-row result. Otherwise hand the SQL to the
 *      validator (regex guard + EXPLAIN cost gate). On rejection we currently
 *      bubble the validator reasons as the workflow output — a v2 enhancement
 *      can loop back to the planner with the reasons attached.
 *
 *   3. executeStep
 *      Runs the validated SQL with the runner (BEGIN READ ONLY, row cap, PII
 *      masking).
 *
 *   4. narrateStep
 *      Invokes the narrator agent with the question, SQL, and result rows.
 *      Produces the final natural-language answer.
 *
 * Prior-turn memory (2-turn cap, per types.DbQueryInput.priorTurns) is passed
 * in by the caller — typically the HTTP route reads it from a session store
 * (out of scope for v1, no persistence yet) and supplies it on each request.
 * We deliberately do NOT persist prior turns inside the workflow itself; the
 * route layer owns conversation state.
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { dbAnalystAgent, dbNarratorAgent } from './agents.js';
import { runValidatedSql } from './runner.js';
import { validateSql } from './validator.js';
import {
  ConnectionIdSchema,
  DbQueryInputSchema,
  DbQueryOutputSchema,
  type ConnectionId,
} from './types.js';

// ─── Inter-step schemas ─────────────────────────────────────────────────────

const PlanResultSchema = z.object({
  sql: z.string(),
  connectionId: ConnectionIdSchema,
  tablesUsed: z.array(z.string()),
  reasoning: z.string(),
  needsClarification: z.string().nullable().default(null),
});
type PlanResult = z.infer<typeof PlanResultSchema>;

const PlanStepOutputSchema = z.object({
  plan: PlanResultSchema,
  inputQuestion: z.string(),
  startedAt: z.number(),
});

const ValidateStepOutputSchema = z.object({
  plan: PlanResultSchema,
  inputQuestion: z.string(),
  startedAt: z.number(),
  /** Validated SQL (possibly LIMIT-injected). Null when validation failed or clarification was needed. */
  effectiveSql: z.string().nullable(),
  validatorNotes: z.array(z.string()),
  validatorRejection: z.string().nullable(),
});

const ExecuteStepOutputSchema = z.object({
  plan: PlanResultSchema,
  inputQuestion: z.string(),
  startedAt: z.number(),
  effectiveSql: z.string().nullable(),
  validatorNotes: z.array(z.string()),
  validatorRejection: z.string().nullable(),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  piiMasked: z.array(z.string()),
});

/**
 * Pull a valid PlanResult out of an agent result that may or may not have
 * produced clean structured output.
 *
 * Order of attempts:
 *   1. `result.object` (the happy path — structured output parsed).
 *   2. JSON embedded in `result.text` (model emitted JSON as text, e.g. after
 *      a tool call exhausted its structured-output turn).
 *   3. A safe fallback that asks the user to rephrase — guarantees the
 *      workflow never throws on an undefined plan.
 *
 * `fallbackConnection` seeds the connectionId when we have to synthesise a
 * plan (defaults to 'openarc' if the caller didn't pin one).
 */
export function extractPlan(result: unknown, fallbackConnection: string | undefined): PlanResult {
  const r = result as { object?: unknown; text?: string };

  // (1) structured output
  if (r.object) {
    const parsed = PlanResultSchema.safeParse(r.object);
    if (parsed.success) return parsed.data;
  }

  // (2) JSON-in-text — grab the first {...} block and try to parse it
  if (typeof r.text === 'string' && r.text.includes('{')) {
    const start = r.text.indexOf('{');
    const end = r.text.lastIndexOf('}');
    if (end > start) {
      try {
        const parsed = PlanResultSchema.safeParse(JSON.parse(r.text.slice(start, end + 1)));
        if (parsed.success) return parsed.data;
      } catch {
        /* fall through */
      }
    }
  }

  // (3) graceful fallback
  console.warn('[db-query] planner produced no parseable structured output — falling back to clarification');
  return {
    sql: '',
    connectionId: (fallbackConnection ?? 'openarc') as ConnectionId,
    tablesUsed: [],
    reasoning: 'Planner did not return a structured plan.',
    needsClarification:
      "I couldn't turn that into a query. Could you rephrase, or name the data you're after (e.g. a table or metric)?",
  };
}

// ─── 1. planStep ────────────────────────────────────────────────────────────

const planStep = createStep({
  id: 'plan',
  inputSchema: DbQueryInputSchema,
  outputSchema: PlanStepOutputSchema,
  execute: async ({ inputData }) => {
    const startedAt = Date.now();

    // Compose the planner prompt. We keep prior turns short and structured —
    // the planner only needs question/sql/db shape to do follow-ups like
    // "and break that by month".
    const priorBlock =
      inputData.priorTurns.length > 0
        ? '\n\n## Prior turns (most recent last)\n' +
          inputData.priorTurns
            .map(
              (t, i) =>
                `[${i + 1}] db=${t.connectionId}\n    Q: ${t.question}\n    SQL: ${t.sql}`,
            )
            .join('\n')
        : '';

    const hintedConnection = inputData.connectionId
      ? `\n\nHint: the caller pre-selected database \`${inputData.connectionId}\`. Use it unless the question clearly belongs elsewhere.`
      : '';

    const prompt =
      `## Current question\n${inputData.question}${hintedConnection}${priorBlock}\n\n` +
      `Now: ground yourself with the tools as needed, then draft ONE SELECT.`;

    const result = await dbAnalystAgent.generate(prompt, {
      structuredOutput: { schema: PlanResultSchema },
    });

    // Robustly extract the structured plan. When an agent both calls tools and
    // emits structured output, `.object` can be undefined (parse failed, or the
    // model ran out of steps after the last tool call). Fall back to parsing
    // the raw text, and finally to a graceful clarification so the workflow
    // never crashes on a missing field.
    const plan = extractPlan(result, inputData.connectionId);

    console.log(
      `[db-query] plan: db=${plan.connectionId} tables=[${plan.tablesUsed.join(', ')}] ` +
        `clarification=${plan.needsClarification ? 'yes' : 'no'}`,
    );

    return { plan, inputQuestion: inputData.question, startedAt };
  },
});

// ─── 2. validateStep ────────────────────────────────────────────────────────

const validateStep = createStep({
  id: 'validate',
  inputSchema: PlanStepOutputSchema,
  outputSchema: ValidateStepOutputSchema,
  execute: async ({ inputData }) => {
    const { plan } = inputData;

    // Clarification short-circuit — skip validation + execution.
    if (plan.needsClarification) {
      return {
        ...inputData,
        effectiveSql: null,
        validatorNotes: [],
        validatorRejection: null,
      };
    }

    const verdict = await validateSql(plan.connectionId as ConnectionId, plan.sql);
    if (!verdict.ok) {
      console.warn(`[db-query] validator rejected: ${verdict.reasons.join(' | ')}`);
      return {
        ...inputData,
        effectiveSql: null,
        validatorNotes: [],
        validatorRejection: verdict.reasons.join(' '),
      };
    }
    return {
      ...inputData,
      effectiveSql: verdict.effectiveSql,
      validatorNotes: verdict.notes,
      validatorRejection: null,
    };
  },
});

// ─── 3. executeStep ─────────────────────────────────────────────────────────

const executeStep = createStep({
  id: 'execute',
  inputSchema: ValidateStepOutputSchema,
  outputSchema: ExecuteStepOutputSchema,
  execute: async ({ inputData }) => {
    // Skip execution if there's no validated SQL (clarification or rejection).
    if (!inputData.effectiveSql) {
      return {
        ...inputData,
        rows: [],
        rowCount: 0,
        truncated: false,
        piiMasked: [],
      };
    }

    const tablesReferenced = inputData.plan.tablesUsed
      .map(fqtn => {
        const [schema, table] = fqtn.split('.');
        return table ? { schema, table } : null;
      })
      .filter((x): x is { schema: string; table: string } => x !== null);

    const result = await runValidatedSql(
      inputData.plan.connectionId as ConnectionId,
      inputData.effectiveSql,
      { tablesReferenced },
    );

    console.log(
      `[db-query] execute: rows=${result.rowCount} truncated=${result.truncated} ` +
        `pii_masked=[${result.piiMasked.join(', ')}] ms=${result.ms}`,
    );

    return {
      ...inputData,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      piiMasked: result.piiMasked,
    };
  },
});

// ─── 4. narrateStep ─────────────────────────────────────────────────────────

const narrateStep = createStep({
  id: 'narrate',
  inputSchema: ExecuteStepOutputSchema,
  outputSchema: DbQueryOutputSchema,
  execute: async ({ inputData }) => {
    const { plan, inputQuestion, startedAt, validatorRejection } = inputData;

    // If the planner asked for clarification, the user-facing answer IS the
    // clarification question. Skip the narrator agent entirely (cheaper).
    if (plan.needsClarification) {
      return {
        answer: plan.needsClarification,
        sql: '',
        connectionId: plan.connectionId,
        rowCount: 0,
        truncated: false,
        tablesUsed: plan.tablesUsed,
        clarification: plan.needsClarification,
        ms: Date.now() - startedAt,
      };
    }

    // If validation failed, surface the rejection as the answer. A v2
    // refinement loop can feed this back to the planner; v1 keeps it simple.
    if (validatorRejection) {
      return {
        answer:
          `I drafted a query but it failed validation: ${validatorRejection} ` +
          `Try rephrasing — e.g. add a date range or narrow the criteria.`,
        sql: plan.sql,
        connectionId: plan.connectionId,
        rowCount: 0,
        truncated: false,
        tablesUsed: plan.tablesUsed,
        clarification: null,
        ms: Date.now() - startedAt,
      };
    }

    // Trim rows passed to the narrator. It only needs to *see* enough to
    // describe shape; the full result is returned separately to the caller.
    const NARRATOR_ROW_CAP = 25;
    const sampleRows = inputData.rows.slice(0, NARRATOR_ROW_CAP);

    const prompt =
      `## Question\n${inputQuestion}\n\n` +
      `## SQL that ran\n\`\`\`sql\n${inputData.effectiveSql ?? plan.sql}\n\`\`\`\n\n` +
      `## Result metadata\n` +
      `rowCount=${inputData.rowCount}, truncated=${inputData.truncated}, ` +
      `piiMasked=[${inputData.piiMasked.join(', ')}]\n\n` +
      `## First ${sampleRows.length} row(s) (of ${inputData.rowCount}; PII already masked)\n` +
      JSON.stringify(sampleRows, null, 2);

    const result = await dbNarratorAgent.generate(prompt);
    const answer = ((result as unknown as { text?: string }).text ?? '').trim();

    return {
      answer: answer || 'I ran the query but couldn\'t form an answer — see the SQL and rows.',
      sql: inputData.effectiveSql ?? plan.sql,
      connectionId: plan.connectionId,
      rowCount: inputData.rowCount,
      truncated: inputData.truncated,
      tablesUsed: plan.tablesUsed,
      clarification: null,
      ms: Date.now() - startedAt,
    };
  },
});

// ─── Workflow assembly ──────────────────────────────────────────────────────

export const dbQueryWorkflow = createWorkflow({
  id: 'db-query-workflow',
  inputSchema: DbQueryInputSchema,
  outputSchema: DbQueryOutputSchema,
})
  .then(planStep)
  .then(validateStep)
  .then(executeStep)
  .then(narrateStep);

dbQueryWorkflow.commit();
