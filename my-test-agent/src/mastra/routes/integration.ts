/**
 * Integration surface — endpoints external apps (OpenArc, future others) use.
 *
 * Three routes:
 *   GET  /integration/info                       — discovery (lists workflows, agents, reco configs)
 *   GET  /integration/reco/runs                  — list recent reco runs (for dashboards)
 *   GET  /integration/reco/runs/:runId/decisions — list decisions for one run
 *
 * Auth model:
 *   - If MASTRA_INTEGRATION_TOKEN env var is set, requests MUST send
 *     Authorization: Bearer <token>. Missing/wrong → 401.
 *   - If the env var is empty/unset, requests pass through (dev mode).
 *
 * Production note: put a reverse proxy (nginx / OpenArc backend) in front
 * of the entire Mastra service that enforces auth on /api/workflows/*. This
 * file's auth is the lighter-weight check for OpenArc → Mastra calls.
 */

import type { ApiRoute } from '@mastra/core/server';
import { listConfigs } from '../reconciliation/adapter.js';
import { dbListRecoRuns, dbListRecoDecisions } from '../reconciliation/db.js';
import { MATCH_TYPE_LABELS } from '../reconciliation/types.js';
import '../reconciliation/configs.js';

function checkToken(c: { req: { header: (k: string) => string | undefined } }):
  | { ok: true }
  | { ok: false; status: 401; error: string } {
  const required = process.env.MASTRA_INTEGRATION_TOKEN;
  if (!required) return { ok: true }; // dev mode — no token required
  const got = c.req.header('authorization') || c.req.header('Authorization');
  if (!got || got !== `Bearer ${required}`) {
    return { ok: false, status: 401, error: 'Missing or invalid Authorization: Bearer <token>' };
  }
  return { ok: true };
}

// ─── GET /integration/info ───────────────────────────────────────────────────

export const integrationInfoRoute: ApiRoute = {
  path: '/integration/info',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: any) => {
    const auth = checkToken(c);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    // Lazy-list — we don't need to enumerate every Mastra workflow exhaustively;
    // OpenArc only needs to know which configs/workflows are wired up here.
    const recoConfigs = listConfigs().map(cfg => ({
      id: cfg.id,
      name: cfg.name,
      description: cfg.description,
      sources: cfg.sources.map(s => s.adapterId),
      matchCount: cfg.matches.length,
    }));

    return c.json({
      version: '1.0.0',
      workflows: [
        {
          id: 'reconcileWorkflow',
          name: 'Statement Reconciliation',
          description: 'Multi-source statement reco (POS / PG / Bank / Marketplace).',
          inputSchema: { configId: 'string (see reco.configs)', date: 'YYYY-MM-DD' },
          startEndpoint: 'POST /api/workflows/reconcileWorkflow/start-async',
        },
        {
          id: 'supportTriageWorkflow',
          name: 'Support Triage',
          description: 'Reads a Freshdesk ticket, classifies, drafts private-note reply.',
          inputSchema: { ticketId: 'number', autoSendReply: 'boolean (default false)' },
          startEndpoint: 'POST /api/workflows/supportTriageWorkflow/start-async',
        },
        {
          id: 'processMeetingWorkflow',
          name: 'Process Meeting',
          description: 'Downloads transcript, summarizes, posts to Slack. Webhook-driven.',
          inputSchema: { transcriptId: 'string', botId: 'string', meetingTitle: 'string?', meetingType: 'enum?' },
          startEndpoint: 'POST /api/workflows/processMeetingWorkflow/start-async',
        },
        {
          id: 'deployMeetingBotWorkflow',
          name: 'Deploy Meeting Bot',
          description: 'Sends a Recall.ai bot to a meeting URL to record + transcribe.',
          inputSchema: { meetingUrl: 'string', joinAt: 'ISO datetime?', meetingTitle: 'string?', meetingType: 'enum?' },
          startEndpoint: 'POST /api/workflows/deployMeetingBotWorkflow/start-async',
        },
      ],
      agents: [
        { id: 'knowledgeAgent', name: 'Knowledge Bot', model: 'gpt-4o-mini' },
        { id: 'supportTriageAgent', name: 'Support Triage', model: 'gpt-4o' },
        { id: 'meetingAgent', name: 'Meeting Summarizer', model: 'gpt-4o' },
        { id: 'zeusAgent', name: 'Zeus (agentic payments)', model: 'gpt-5-mini' },
        { id: 'fuzzyMatchAgent', name: 'Reco Fuzzy Matcher', model: 'gpt-4o-mini' },
        { id: 'dispositionAgent', name: 'Reco Disposition', model: 'gpt-4o-mini' },
      ],
      reconciliation: {
        configs: recoConfigs,
        listRunsEndpoint: 'GET /integration/reco/runs',
        listDecisionsEndpoint: 'GET /integration/reco/runs/:runId/decisions',
        // Customer-facing label + tone + description per match type. OpenArc
        // (and any future UI) renders badges from this map, so adding a new
        // match type doesn't require a UI release.
        matchTypeLabels: MATCH_TYPE_LABELS,
      },
      authRequired: !!process.env.MASTRA_INTEGRATION_TOKEN,
    });
  }),
};

// ─── GET /integration/reco/runs ──────────────────────────────────────────────

export const integrationRecoRunsRoute: ApiRoute = {
  path: '/integration/reco/runs',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: any) => {
    const auth = checkToken(c);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const limit = Number(c.req.query('limit') ?? 50);
    const runs = await dbListRecoRuns({ limit });
    return c.json({
      count: runs.length,
      runs: runs.map(r => ({
        runId: r.id,
        date: r.date,
        source: r.source,
        state: r.state,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  }),
};

// ─── GET /integration/reco/runs/:runId/decisions ─────────────────────────────

export const integrationRecoDecisionsRoute: ApiRoute = {
  path: '/integration/reco/runs/:runId/decisions',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: any) => {
    const auth = checkToken(c);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const runId = c.req.param('runId');
    const decisions = await dbListRecoDecisions(runId);
    return c.json({
      runId,
      count: decisions.length,
      decisions,
    });
  }),
};
