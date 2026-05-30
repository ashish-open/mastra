/**
 * Eval runner for the db-query agent.
 *
 * Run:
 *   pnpm eval:db-query
 *
 * What it does:
 *   - Registers the db-query connections from env (read-only roles).
 *   - For each golden case: runs the FULL pipeline (plan → validate → execute
 *     → narrate) by invoking the steps directly (NOT the mastra instance, so
 *     it can run while `pnpm dev` holds the DuckDB lock — mirrors eval:reco).
 *   - Scores each case via result-set equality + structural checks.
 *   - Prints a per-case table and headline accuracy.
 *
 * Requires OPENARC_DB_RO_URL to be set. If no connection registers, the runner
 * prints a clear message and exits 0 (so CI doesn't fail on an unconfigured env).
 *
 * Calibration: many golden cases ship as templates (see golden.ts). Until you
 * fill in real reference SQL, the headline reflects only the schema-agnostic +
 * clarification cases.
 */

import { registerDbQueryConnections } from '../bootstrap.js';
import { listConnections } from '../connections.js';
import { dbAnalystAgent, dbNarratorAgent } from '../agents.js';
import { validateSql } from '../validator.js';
import { runValidatedSql } from '../runner.js';
import { extractPlan } from '../workflow.js';
import { scoredCases, type GoldenCase } from './golden.js';
import { scoreResultSetEquality, scoreStructural, type ScoreResult } from './scorers.js';
import { z } from 'zod';
import type { ConnectionId } from '../types.js';

const PlanResultSchema = z.object({
  sql: z.string(),
  connectionId: z.string(),
  tablesUsed: z.array(z.string()),
  reasoning: z.string(),
  needsClarification: z.string().nullable().default(null),
});
type PlanResult = z.infer<typeof PlanResultSchema>;

interface CaseOutcome {
  name: string;
  category: string;
  scores: ScoreResult[];
  finalScore: number;
  sql: string;
  answer: string;
  error?: string;
}

/** Run the pipeline for ONE question — mirrors workflow.ts but inline for evals. */
async function runPipeline(caseDef: GoldenCase): Promise<{
  sql: string;
  connectionId: string;
  tablesUsed: string[];
  clarification: string | null;
  answer: string;
  rows: Array<Record<string, unknown>>;
}> {
  const hinted = caseDef.connectionId ? `\n\nHint: use database \`${caseDef.connectionId}\`.` : '';
  const prompt = `## Current question\n${caseDef.question}${hinted}\n\nGround yourself with the tools, then draft ONE SELECT.`;

  const planRes = await dbAnalystAgent.generate(prompt, { structuredOutput: { schema: PlanResultSchema } });
  // Reuse the workflow's robust extraction so the eval exercises the SAME
  // defensive path production does (handles undefined .object / JSON-in-text).
  const plan = extractPlan(planRes, caseDef.connectionId);

  if (plan.needsClarification) {
    return {
      sql: '',
      connectionId: plan.connectionId,
      tablesUsed: plan.tablesUsed,
      clarification: plan.needsClarification,
      answer: plan.needsClarification,
      rows: [],
    };
  }

  const verdict = await validateSql(plan.connectionId as ConnectionId, plan.sql);
  if (!verdict.ok) {
    return {
      sql: plan.sql,
      connectionId: plan.connectionId,
      tablesUsed: plan.tablesUsed,
      clarification: null,
      answer: `[validator rejected] ${verdict.reasons.join(' ')}`,
      rows: [],
    };
  }

  const tablesReferenced = plan.tablesUsed
    .map(fqtn => {
      const [schema, table] = fqtn.split('.');
      return table ? { schema, table } : null;
    })
    .filter((x): x is { schema: string; table: string } => x !== null);

  const exec = await runValidatedSql(plan.connectionId as ConnectionId, verdict.effectiveSql, { tablesReferenced });

  const narratePrompt =
    `## Question\n${caseDef.question}\n\n## SQL\n${verdict.effectiveSql}\n\n` +
    `## Metadata\nrowCount=${exec.rowCount}, truncated=${exec.truncated}, piiMasked=[${exec.piiMasked.join(', ')}]\n\n` +
    `## Rows\n${JSON.stringify(exec.rows.slice(0, 25), null, 2)}`;
  const narrateRes = await dbNarratorAgent.generate(narratePrompt);
  const answer = ((narrateRes as unknown as { text?: string }).text ?? '').trim();

  return {
    sql: verdict.effectiveSql,
    connectionId: plan.connectionId,
    tablesUsed: plan.tablesUsed,
    clarification: null,
    answer,
    rows: exec.rows,
  };
}

async function scoreCase(caseDef: GoldenCase): Promise<CaseOutcome> {
  const scores: ScoreResult[] = [];
  try {
    const result = await runPipeline(caseDef);

    if (caseDef.referenceSql && !caseDef.expectClarification) {
      scores.push(await scoreResultSetEquality(caseDef.connectionId as ConnectionId, caseDef.referenceSql, result.rows));
    }
    const structural = scoreStructural(caseDef, result);
    if (structural.note !== 'no structural checks') scores.push(structural);

    const finalScore = scores.length ? scores.reduce((a, s) => a + s.score, 0) / scores.length : 0;
    return { name: caseDef.name, category: caseDef.category, scores, finalScore, sql: result.sql, answer: result.answer };
  } catch (err) {
    return {
      name: caseDef.name,
      category: caseDef.category,
      scores: [],
      finalScore: 0,
      sql: '',
      answer: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const registered = registerDbQueryConnections();
  if (registered === 0) {
    console.log(
      '\n[eval:db-query] No connections registered (OPENARC_DB_RO_URL unset). ' +
        'Set a read-only DSN to run the eval. Exiting 0.\n',
    );
    process.exit(0);
  }

  console.log(`\n[eval:db-query] connections: ${listConnections().map(c => c.id).join(', ')}`);

  const cases = scoredCases();
  console.log(`[eval:db-query] running ${cases.length} scored case(s)...\n`);

  const outcomes: CaseOutcome[] = [];
  for (const c of cases) {
    process.stdout.write(`  • ${c.name} ... `);
    const outcome = await scoreCase(c);
    outcomes.push(outcome);
    if (outcome.error) {
      console.log(`ERROR (${outcome.error})`);
    } else {
      const pct = Math.round(outcome.finalScore * 100);
      console.log(`${pct}%  ${outcome.scores.map(s => s.note).join(' | ')}`);
    }
  }

  // Headlines — split deterministic SQL accuracy from variance-prone
  // behavioral cases (clarification/ambiguity). Blending them produces a
  // meaningless headline that bounces run-to-run on LLM variance. The SQL
  // number is the one to track for "is the agent getting the data right?".
  const isBehavioral = (o: CaseOutcome) => o.category === 'ambiguous' || o.category === 'routing';
  const sqlCases = outcomes.filter(o => !isBehavioral(o));
  const behavioralCases = outcomes.filter(isBehavioral);

  const summarise = (group: CaseOutcome[]) => {
    const scored = group.filter(o => !o.error);
    const avg = scored.length ? scored.reduce((a, o) => a + o.finalScore, 0) / scored.length : 0;
    const passed = scored.filter(o => o.finalScore >= 0.99).length;
    return { total: group.length, errored: group.length - scored.length, passed, scoredN: scored.length, avg };
  };
  const sql = summarise(sqlCases);
  const beh = summarise(behavioralCases);

  console.log('\n══════════════════════════════════════════════');
  console.log('  SQL ACCURACY (deterministic — track this)');
  console.log(`    fully correct:  ${sql.passed}/${sql.scoredN}` + (sql.errored ? `  (${sql.errored} errored)` : ''));
  console.log(`    mean score:     ${Math.round(sql.avg * 100)}%`);
  console.log('  ─────────────────────────────────────────');
  console.log('  BEHAVIORAL (clarification — LLM-variance, advisory)');
  console.log(`    fully correct:  ${beh.passed}/${beh.scoredN}` + (beh.errored ? `  (${beh.errored} errored)` : ''));
  console.log(`    mean score:     ${Math.round(beh.avg * 100)}%`);
  console.log('══════════════════════════════════════════════\n');

  if (outcomes.some(o => o.error)) {
    console.log('Errored cases:');
    for (const o of outcomes.filter(x => x.error)) console.log(`  ✗ ${o.name}: ${o.error}`);
    console.log('');
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[eval:db-query] fatal:', err);
    process.exit(1);
  });
