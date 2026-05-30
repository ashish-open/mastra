/**
 * db-query routes — natural-language → SQL question answering.
 *
 *   POST /db-query/ask              — ask a question, get a grounded answer
 *   POST /db-query/refresh-schema   — drop the cached schema for a connection
 *                                     (call after a migration lands in the DB)
 *
 * Auth model mirrors routes/integration.ts: if MASTRA_INTEGRATION_TOKEN is
 * set, requests must send `Authorization: Bearer <token>`; if unset, dev
 * mode lets everything through.
 *
 * Conversation state:
 *   The route is the owner of multi-turn memory (the workflow is stateless).
 *   For v1 we don't persist server-side; instead the CALLER passes back the
 *   prior turns it received. The response includes a `turn` object the caller
 *   should stash and resend (capped at the last 2 by the input schema). This
 *   keeps the Mastra service stateless and lets OpenArc own session storage.
 *
 * Request (POST /db-query/ask):
 *   {
 *     "question": "how many agent runs failed yesterday?",
 *     "connectionId": "openarc",          // optional — planner picks if omitted
 *     "priorTurns": [                       // optional, max 2
 *       { "question": "...", "sql": "...", "connectionId": "openarc" }
 *     ]
 *   }
 *
 * Response:
 *   {
 *     "answer": "...",
 *     "sql": "...",
 *     "connectionId": "openarc",
 *     "rowCount": 12,
 *     "truncated": false,
 *     "tablesUsed": ["public.agent_runs"],
 *     "clarification": null,
 *     "ms": 1840,
 *     "turn": { "question": "...", "sql": "...", "connectionId": "openarc" }
 *   }
 */

import type { ApiRoute } from '@mastra/core/server';
import { DbQueryInputSchema, type DbQueryOutput } from '../db-query/types.js';
import { invalidateConnection } from '../db-query/schema-cache.js';

function checkToken(c: { req: { header: (k: string) => string | undefined } }):
  | { ok: true }
  | { ok: false; status: 401; error: string } {
  const required = process.env.MASTRA_INTEGRATION_TOKEN;
  if (!required) return { ok: true };
  const got = c.req.header('authorization') || c.req.header('Authorization');
  if (!got || got !== `Bearer ${required}`) {
    return { ok: false, status: 401, error: 'Missing or invalid Authorization: Bearer <token>' };
  }
  return { ok: true };
}

// ─── POST /db-query/ask ───────────────────────────────────────────────────────

export const dbQueryAskRoute: ApiRoute = {
  path: '/db-query/ask',
  method: 'POST',
  requiresAuth: false, // guarded by MASTRA_INTEGRATION_TOKEN
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: ({ mastra }): any =>
    Promise.resolve(async (c: any) => {
      const auth = checkToken(c);
      if (!auth.ok) return c.json({ error: auth.error }, auth.status);

      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      // Validate + coerce with the same Zod schema the workflow expects.
      const parsed = DbQueryInputSchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          { error: 'Invalid request body', details: parsed.error.flatten() },
          400,
        );
      }
      const input = parsed.data;

      console.log(
        `[db-query] ask: q="${input.question.slice(0, 80)}" ` +
          `db=${input.connectionId ?? '(auto)'} priorTurns=${input.priorTurns.length}`,
      );

      const workflow = (mastra as unknown as {
        getWorkflow: (id: string) => {
          createRunAsync: () => Promise<{
            start: (args: { inputData: unknown }) => Promise<{
              status: string;
              result?: DbQueryOutput;
              error?: unknown;
            }>;
          }>;
        } | undefined;
      }).getWorkflow('dbQueryWorkflow');

      if (!workflow) {
        return c.json({ error: 'dbQueryWorkflow not found' }, 500);
      }

      let result: DbQueryOutput;
      try {
        const run = await workflow.createRunAsync();
        const outcome = await run.start({ inputData: input });
        if (outcome.status !== 'success' || !outcome.result) {
          console.error('[db-query] workflow non-success:', outcome.status, outcome.error);
          return c.json(
            { error: 'Query workflow failed. Check server logs for details.' },
            500,
          );
        }
        result = outcome.result;
      } catch (err) {
        console.error('[db-query] workflow error:', err);
        return c.json({ error: 'Query workflow threw. Check server logs.' }, 500);
      }

      // Build the `turn` the caller should stash for follow-ups. We only emit
      // one when there's real SQL (skip clarifications — they have no SQL).
      const turn =
        result.sql && !result.clarification
          ? {
              question: input.question,
              sql: result.sql,
              connectionId: result.connectionId,
            }
          : null;

      return c.json({ ...result, turn });
    }),
};

// ─── POST /db-query/refresh-schema ────────────────────────────────────────────

export const dbQueryRefreshSchemaRoute: ApiRoute = {
  path: '/db-query/refresh-schema',
  method: 'POST',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any =>
    Promise.resolve(async (c: any) => {
      const auth = checkToken(c);
      if (!auth.ok) return c.json({ error: auth.error }, auth.status);

      let body: { connectionId?: string };
      try {
        body = (await c.req.json()) as { connectionId?: string };
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }
      const connectionId = body.connectionId?.trim();
      if (!connectionId) {
        return c.json({ error: 'Body must include "connectionId"' }, 400);
      }

      await invalidateConnection(connectionId);
      console.log(`[db-query] schema cache invalidated for '${connectionId}'`);
      return c.json({ ok: true, connectionId, message: 'Schema cache cleared; next query re-introspects.' });
    }),
};
