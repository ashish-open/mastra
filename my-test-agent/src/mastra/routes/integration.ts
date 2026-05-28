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
      // Which workflow runs this config. OpenArc routes the run to this id.
      // Deterministic settlement configs → 'settlement-recon' (no LLM, no review
      // gate); everything else → 'reconcile-workflow' (LLM fuzzy + disposition).
      workflow: cfg.workflow ?? 'reconcile-workflow',
      deterministic: (cfg.workflow ?? 'reconcile-workflow') === 'settlement-recon',
    }));

    return c.json({
      version: '1.0.0',
      workflows: [
        {
          id: 'reconcile-workflow',
          name: 'Statement Reconciliation (LLM-assisted)',
          description: 'Multi-source reco with deterministic match + LLM fuzzy/disposition + human review gate. For configs where a fuzzy false-positive is low-cost.',
          inputSchema: { configId: 'string (see reco.configs)', date: 'YYYY-MM-DD' },
          startEndpoint: 'POST /api/workflows/reconcile-workflow/start-async',
        },
        {
          id: 'settlement-recon',
          name: 'Settlement Reconciliation (deterministic)',
          description: 'Money-critical settlement reco. Pure rules — NO LLM, no human review gate. Produces summary + settlement + exception reports. Used by configs with workflow=settlement-recon.',
          inputSchema: { configId: 'string (see reco.configs)', date: 'YYYY-MM-DD' },
          startEndpoint: 'POST /api/workflows/settlement-recon/start-async',
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
      meetings: {
        listEndpoint: 'GET /integration/meetings?type=<type>&limit=50',
        detailEndpoint: 'GET /integration/meetings/:botId',
        askEndpoint: 'POST /recall/ask/:botId',
        deployBotEndpoint: 'POST /api/workflows/deployMeetingBotWorkflow/start-async',
        types: ['sales', 'onboarding', 'support', 'ops', 'finance', 'product', 'engineering', 'hr', 'general'],
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
    // Optional ?limit= — callers needing only a UI sample (OpenArc decisions
    // table) cap the result so we don't serialize 100k+ rows. Clamp to a sane
    // ceiling. The report-pack builder reads from the DB directly (no HTTP),
    // so the full set is always available for the audit log.
    const rawLimit = parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5000) : undefined;
    const decisions = await dbListRecoDecisions(runId, limit);
    return c.json({
      runId,
      count: decisions.length,
      limited: limit !== undefined && decisions.length >= limit,
      decisions,
    });
  }),
};

// ─── GET /integration/meetings ──────────────────────────────────────────────
//
// Lists processed meetings for the OpenArc Meetings queue page. Reads from
// mastra_workflow_snapshot — we don't have a dedicated meetings table yet,
// so we project the workflow's persisted output. This is fine up to a few
// hundred meetings; move to a dedicated table when volume grows.
//
// Query params:
//   - type=sales|onboarding|... (optional filter by meetingType)
//   - limit=50 (default 50, max 200)
//   - status=success|failed (default success — failed runs hide from UI)

interface MeetingListItem {
  botId: string;
  runId: string;
  meetingTitle: string;
  meetingType: string;
  slackChannel?: string;
  slackPosted?: boolean;
  durationMinutes?: number;
  speakerCount?: number;
  oneLineSummary?: string;
  createdAt: string;
}

/** Best-effort one-liner extracted from the agent's structured summary.
 *  Pulls the line after "### One-line Summary" header, or the first
 *  non-empty paragraph if that header isn't present. */
function extractOneLiner(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const oneLiner = summary.match(/###\s*One-line Summary[^\n]*\n+([^\n]+)/i);
  if (oneLiner?.[1]) return oneLiner[1].trim();
  const firstPara = summary.trim().split(/\n\s*\n/)[0]?.replace(/^#+\s*/, '').trim();
  return firstPara && firstPara.length < 300 ? firstPara : firstPara?.slice(0, 280) + '…';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function snapshotContext(snapshot: any): any {
  if (!snapshot) return undefined;
  if (typeof snapshot === 'string') {
    try { return JSON.parse(snapshot).context; } catch { return undefined; }
  }
  return snapshot.context;
}

export const integrationMeetingsListRoute: ApiRoute = {
  path: '/integration/meetings',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: ({ mastra }): any => Promise.resolve(async (c: any) => {
    const auth = checkToken(c);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const typeFilter = c.req.query('type') as string | undefined;
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

    // Composite storage exposes domain stores via getStore('workflows').
    // The workflows domain has listWorkflowRuns / getWorkflowRunById methods.
    const storage = (mastra as {
      getStorage?: () => {
        getStore: (name: 'workflows') => Promise<
          | {
              listWorkflowRuns: (i: unknown) => Promise<{
                runs: Array<{
                  workflowName: string;
                  runId: string;
                  snapshot: unknown;
                  createdAt: Date | string;
                  updatedAt: Date | string;
                  status?: string;
                }>;
              }>;
            }
          | undefined
        >;
      };
    })?.getStorage?.();
    const workflowsStore = await storage?.getStore('workflows');
    if (!workflowsStore) return c.json({ error: 'workflows storage not available' }, 500);

    const result = await workflowsStore.listWorkflowRuns({
      workflowName: 'process-meeting-workflow',
      status: 'success',
      perPage: limit,
      page: 0,
    });

    const items: MeetingListItem[] = result.runs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any) => {
        const ctx = snapshotContext(r.snapshot);
        const dl = ctx?.['download-transcript']?.output ?? {};
        const gen = ctx?.['generate-and-post-summary']?.output ?? {};
        return {
          botId: gen.botId ?? dl.botId ?? '',
          runId: r.runId,
          meetingTitle: gen.meetingTitle ?? dl.meetingTitle ?? 'Untitled Meeting',
          meetingType: gen.meetingType ?? dl.meetingType ?? 'general',
          slackChannel: gen.slackChannel,
          slackPosted: gen.slackPosted,
          durationMinutes: dl.durationMinutes,
          speakerCount: dl.speakerCount,
          oneLineSummary: extractOneLiner(gen.summary),
          createdAt: r.createdAt,
        };
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((m: MeetingListItem) => !typeFilter || m.meetingType === typeFilter);

    return c.json({
      count: items.length,
      meetings: items,
    });
  }),
};

// ─── GET /integration/meetings/:botId ───────────────────────────────────────
//
// Returns the full summary + transcript metadata for a single meeting.
// botId is the stable identity (one per Recall.ai bot), unlike runId which
// would change on reprocess. We look up by scanning recent runs and
// matching botId — fine for the volumes we expect; if it gets slow, add a
// dedicated index/table.

export const integrationMeetingDetailRoute: ApiRoute = {
  path: '/integration/meetings/:botId',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: ({ mastra }): any => Promise.resolve(async (c: any) => {
    const auth = checkToken(c);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const botId = c.req.param('botId');
    // Composite storage exposes domain stores via getStore('workflows').
    // The workflows domain has listWorkflowRuns / getWorkflowRunById methods.
    const storage = (mastra as {
      getStorage?: () => {
        getStore: (name: 'workflows') => Promise<
          | {
              listWorkflowRuns: (i: unknown) => Promise<{
                runs: Array<{
                  workflowName: string;
                  runId: string;
                  snapshot: unknown;
                  createdAt: Date | string;
                  updatedAt: Date | string;
                  status?: string;
                }>;
              }>;
            }
          | undefined
        >;
      };
    })?.getStorage?.();
    const workflowsStore = await storage?.getStore('workflows');
    if (!workflowsStore) return c.json({ error: 'workflows storage not available' }, 500);

    const result = await workflowsStore.listWorkflowRuns({
      workflowName: 'process-meeting-workflow',
      perPage: 500,
      page: 0,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = result.runs.find((r: any) => {
      const ctx = snapshotContext(r.snapshot);
      const gen = ctx?.['generate-and-post-summary']?.output ?? {};
      const dl = ctx?.['download-transcript']?.output ?? {};
      const input = ctx?.input ?? {};
      return gen.botId === botId || dl.botId === botId || input.botId === botId;
    });

    if (!match) return c.json({ error: 'Meeting not found' }, 404);

    const ctx = snapshotContext(match.snapshot);
    const dl = ctx?.['download-transcript']?.output ?? {};
    const gen = ctx?.['generate-and-post-summary']?.output ?? {};

    return c.json({
      botId,
      runId: match.runId,
      status: match.status,
      meetingTitle: gen.meetingTitle ?? dl.meetingTitle ?? 'Untitled Meeting',
      meetingType: gen.meetingType ?? dl.meetingType ?? 'general',
      durationMinutes: dl.durationMinutes,
      speakerCount: dl.speakerCount,
      wordCount: dl.wordCount,
      detectedType: dl.detectedType,
      summary: gen.summary,
      oneLineSummary: extractOneLiner(gen.summary),
      slack: {
        posted: gen.slackPosted ?? false,
        channel: gen.slackChannel,
        skipped: gen.slackSkipped,
        error: gen.slackError,
      },
      askEndpoint: `/recall/ask/${botId}`,
      createdAt: match.createdAt,
      updatedAt: match.updatedAt,
    });
  }),
};
