# Prompt to paste into the OpenArc Claude session

---

We're integrating a Mastra-based AI agents service (called "OpenArc Agents") into the OpenArc dashboard. The Mastra service runs separately and exposes HTTP endpoints; OpenArc will be the user-facing layer.

## What lives on the Mastra side (already built)

Path: `/Users/ashish.s/Documents/Mastra/mastra/my-test-agent`

Endpoints documented in `INTEGRATION.md` at the Mastra repo root. The full surface is:

**Workflows (Mastra-native HTTP, JSON):**
- `POST /api/workflows/<workflowId>/start-async` — fire-and-forget; returns `runId`
- `GET  /api/workflows/<workflowId>/runs/<runId>` — poll for state + output
- `GET  /api/workflows/<workflowId>/runs?limit=N` — list recent runs
- `POST /api/workflows/<workflowId>/runs/<runId>/resume` — for human-in-loop steps

Workflows registered today: `reconcileWorkflow`, `supportTriageWorkflow`, `processMeetingWorkflow`, `deployMeetingBotWorkflow`. More coming.

**Custom integration endpoints (Bearer token auth):**
- `GET  /integration/info` — discovery: lists workflows, agents, reco configs
- `GET  /integration/reco/runs` — recent reco runs (flat shape for dashboards)
- `GET  /integration/reco/runs/:runId/decisions` — audit-log decisions for one run
- `POST /reco/upload` — multipart upload of bank/PG statement CSV → parsed `NormalizedTxn[]`

**Auth:**
- `Authorization: Bearer <MASTRA_INTEGRATION_TOKEN>` on `/integration/*`
- Built-in `/api/workflows/*` is open at the Mastra service. We rely on the OpenArc backend being the only caller, plus a reverse proxy in prod.

---

## What you (the OpenArc Claude session) need to build

A new module called **`agents`** following the exact pattern of the existing `kyc` module. Reference files:
- Backend: `backend/src/modules/kyc/` (routes, controllers, services)
- Frontend: `src/modules/kyc/` (manifest.json, pages, services, routes.tsx)
- Migration: `backend/src/migrations/011_kyc_module_seed.sql` (RBAC seeding pattern)

### 1. Backend module — `backend/src/modules/agents/`

```
agents/
├── index.ts                            ← exports createAgentsRoutes
├── services/
│   └── mastra-client.service.ts        ← HTTP client to Mastra (server-to-server)
├── controllers/
│   ├── workflows.controller.ts         ← /api/agents/workflows/...
│   ├── reconciliation.controller.ts    ← /api/agents/reconciliation/...
│   └── support-triage.controller.ts    ← /api/agents/support-triage/...
└── routes/
    └── agents.routes.ts                ← mounts everything
```

**`mastra-client.service.ts`** centralises all Mastra HTTP calls:
- Methods: `getInfo()`, `startWorkflow(id, inputData)`, `getRun(workflowId, runId)`, `listRuns(workflowId, limit)`, `resumeRun(workflowId, runId, resumeData)`, `getRecoRuns()`, `getRecoDecisions(runId)`, `uploadRecoFile(file, adapterId, accountId, date)`
- Reads `process.env.MASTRA_BASE_URL` and `process.env.MASTRA_INTEGRATION_TOKEN`
- Auto-injects `Authorization: Bearer <token>` on `/integration/*` calls
- Retry-safe with exponential backoff on 5xx
- Logs every call with requestId for tracing

**Controller pattern** (mirrors `cpv.controller.ts`):
- Authenticates via existing `authenticateJWT` middleware
- Authorises via `requireAction('agents', '<feature>', '<action>')`
- Calls the MastraClient service
- Audits via `auditAccessEvent` / `auditDataChange`
- Optionally caches recent runs in a local Postgres mirror table for fast UI

**Endpoints to expose:**

| OpenArc endpoint | Mastra call | RBAC |
|---|---|---|
| `GET  /api/agents/info` | `GET /integration/info` | `agents.workflows.view` |
| `GET  /api/agents/workflows/:id/runs?limit=N` | `GET /api/workflows/:id/runs` | `agents.workflows.view` |
| `GET  /api/agents/workflows/:id/runs/:runId` | `GET /api/workflows/:id/runs/:runId` | `agents.workflows.view` |
| `POST /api/agents/workflows/:id/start` | `POST /api/workflows/:id/start-async` | `agents.workflows.run` |
| `POST /api/agents/workflows/:id/runs/:runId/resume` | `POST /api/workflows/:id/runs/:runId/resume` | `agents.workflows.run` |
| `GET  /api/agents/reco/runs` | `GET /integration/reco/runs` | `agents.reconciliation.view` |
| `GET  /api/agents/reco/runs/:runId/decisions` | `GET /integration/reco/runs/:runId/decisions` | `agents.reconciliation.view` |
| `POST /api/agents/reco/upload` (multipart) | `POST /reco/upload` | `agents.reconciliation.run` |
| `POST /api/agents/reco/runs` (body: `{configId, date}`) | starts `reconcileWorkflow` + mirrors to DB | `agents.reconciliation.run` |
| `POST /api/agents/support-triage/runs` (body: `{ticketId, autoSendReply?}`) | starts `supportTriageWorkflow` | `agents.support_triage.run` |

Mount under `apiRouter.use('/agents', createAgentsRoutes(pool))` in `backend/src/index.ts`.

### 2. Postgres — mirror tables

Migration `backend/src/migrations/0XX_agents_module.sql`:

```sql
-- Tracks every workflow run OpenArc has initiated/observed (cache for fast UI)
CREATE TABLE IF NOT EXISTS agent_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   TEXT NOT NULL,           -- 'reconcileWorkflow', 'supportTriageWorkflow', ...
  mastra_run_id TEXT NOT NULL UNIQUE,    -- the runId Mastra returned
  initiated_by  INTEGER REFERENCES users(id),
  input_data    JSONB NOT NULL,
  state         TEXT NOT NULL,           -- 'running' | 'completed' | 'failed' | 'suspended'
  output        JSONB,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  duration_ms   INTEGER,
  CONSTRAINT agent_runs_state_check CHECK (state IN ('running','completed','failed','suspended'))
);
CREATE INDEX idx_agent_runs_workflow_id ON agent_runs(workflow_id);
CREATE INDEX idx_agent_runs_initiated_by ON agent_runs(initiated_by);
CREATE INDEX idx_agent_runs_state ON agent_runs(state);
CREATE INDEX idx_agent_runs_started_at ON agent_runs(started_at DESC);

-- Mirror of reco decisions for audit + fast querying without re-hitting Mastra
CREATE TABLE IF NOT EXISTS reco_decisions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id      UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  mastra_run_id     TEXT NOT NULL,
  source_txn_id     TEXT NOT NULL,
  target_txn_id     TEXT,
  match_type        TEXT NOT NULL,       -- 'exact' | 'fuzzy_auto' | 'fuzzy_human' | 'unmatched' | 'written_off' | 'flagged_fraud'
  amount_delta_paise INTEGER NOT NULL DEFAULT 0,
  decided_by        TEXT NOT NULL,       -- 'system' | <user_id>
  matcher_version   TEXT NOT NULL,
  reasoning         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reco_decisions_mastra_run ON reco_decisions(mastra_run_id);
CREATE INDEX idx_reco_decisions_match_type ON reco_decisions(match_type);
```

**Sync pattern** — when an `agent_runs` row hits state `completed`, the service fetches `/integration/reco/runs/:runId/decisions` once and persists them. Idempotent on `(mastra_run_id, source_txn_id)`.

### 3. Frontend module — `src/modules/agents/`

```
agents/
├── manifest.json
├── index.ts
├── routes.tsx
├── pages/
│   ├── AgentsDashboard.tsx           ← lists all workflows + recent runs
│   ├── ReconcileDashboard.tsx        ← recent reco runs + totals
│   ├── ReconcileRunDetail.tsx        ← drill into one run: decisions table
│   ├── ReconcileUpload.tsx           ← upload bank statement CSV
│   ├── ReconcileNewRun.tsx           ← form: pick config + date, "Run reco"
│   └── SupportTriageQueue.tsx        ← list of recent triage runs + drafts
├── services/
│   └── agentsApiService.ts           ← talks to OpenArc backend /api/agents/*
└── types/
    └── agents.ts                     ← TS types mirroring Mastra responses
```

**`manifest.json`:**

```json
{
  "name": "agents",
  "version": "1.0.0",
  "displayName": "AI Agents",
  "description": "Agentic workflows: reconciliation, support triage, meeting summaries.",
  "category": "Operations",
  "icon": "Bot",
  "permissions": [
    { "module": "agents", "feature": "workflows",      "action": "view", "description": "View workflow runs" },
    { "module": "agents", "feature": "workflows",      "action": "run",  "description": "Start workflow runs" },
    { "module": "agents", "feature": "reconciliation", "action": "view", "description": "View reconciliation runs and decisions" },
    { "module": "agents", "feature": "reconciliation", "action": "run",  "description": "Start reconciliation runs and uploads" },
    { "module": "agents", "feature": "support_triage", "action": "view", "description": "View support triage queue" },
    { "module": "agents", "feature": "support_triage", "action": "run",  "description": "Trigger support triage on a ticket" }
  ],
  "dependencies": [],
  "routes": [
    { "path": "/agents",                          "component": "AgentsDashboard",      "permission": "agents.workflows.view" },
    { "path": "/agents/reconciliation",           "component": "ReconcileDashboard",   "permission": "agents.reconciliation.view" },
    { "path": "/agents/reconciliation/new",       "component": "ReconcileNewRun",      "permission": "agents.reconciliation.run" },
    { "path": "/agents/reconciliation/upload",    "component": "ReconcileUpload",      "permission": "agents.reconciliation.run" },
    { "path": "/agents/reconciliation/:runId",    "component": "ReconcileRunDetail",   "permission": "agents.reconciliation.view" },
    { "path": "/agents/support-triage",           "component": "SupportTriageQueue",   "permission": "agents.support_triage.view" }
  ],
  "navigationItems": [
    {
      "id": "agents",
      "label": "AI Agents",
      "icon": "Bot",
      "path": "/agents",
      "module": "agents",
      "permission": "agents.workflows.view",
      "children": [
        { "id": "agents-reco",    "label": "Reconciliation", "icon": "ListChecks",    "path": "/agents/reconciliation", "module": "agents", "permission": "agents.reconciliation.view" },
        { "id": "agents-triage",  "label": "Support Triage", "icon": "MessageSquare", "path": "/agents/support-triage", "module": "agents", "permission": "agents.support_triage.view" }
      ]
    }
  ]
}
```

### 4. RBAC seed migration

Mirror `011_kyc_module_seed.sql` for the `agents` module: insert into `modules`, `module_features` (3 features: workflows / reconciliation / support_triage), `feature_actions` (view + run per feature), and grant all to role_id=1 (Super-Admin).

### 5. Env vars

Add to `backend/.env.development`:

```
# Mastra integration
MASTRA_BASE_URL=http://localhost:4111
MASTRA_INTEGRATION_TOKEN=     # leave blank for dev — Mastra is unauthed locally
```

Add corresponding entries to `.env.production` / `.env.staging` with appropriate values.

### 6. Critical implementation details

- **Auth model**: every OpenArc backend endpoint authenticates the user (JWT + CSRF as today). Mastra is called server-to-server with the integration bearer token. The browser never talks to Mastra directly.
- **Long-running workflows**: workflows like `reconcileWorkflow` take ~10s, but `processMeetingWorkflow` can run for minutes. Use `/api/agents/workflows/:id/runs/:runId` polling on the frontend with 2-second interval, or wire SSE later. Backend timeout per request should be reasonable (no synchronous blocking on the workflow).
- **Persist on completion**: when polling detects state transition to `completed`, save the output to `agent_runs.output` and (for reco) sync decisions from `/integration/reco/runs/:runId/decisions` to `reco_decisions`.
- **Audit**: every "Start workflow" action is an `auditDataChange`. Every "View runs" is an `auditAccessEvent`.
- **Error mapping**: 401/403 from Mastra → 502 Bad Gateway from OpenArc (token misconfigured, not user fault). Validation errors (400) from Mastra → pass through to the frontend.
- **Module registry**: nothing to update manually — the `agents` module's manifest is read from the DB seed and the registry picks it up automatically (mirror how KYC was added).

---

## Build order

1. Backend `mastra-client.service.ts` first — smoke-test against `GET http://localhost:4111/integration/info`.
2. Migration for `agent_runs` + `reco_decisions` + RBAC seed.
3. Backend controllers + routes.
4. Frontend `agentsApiService.ts`.
5. Frontend manifest + module registry seed.
6. Pages: start with `ReconcileDashboard` + `ReconcileNewRun` since the Mastra side is already runnable end-to-end with mock data.
7. Once one workflow works end-to-end, replicate for support-triage + meetings.

---

## Acceptance checks before considering done

- [ ] Backend can call `GET /api/agents/info` and get back the workflow list.
- [ ] Frontend "AI Agents" appears in the nav for Super-Admin.
- [ ] Pressing "Run reco" with config `bank-pg-internal` + date `2026-05-13` starts a Mastra workflow, polls, and shows totals.
- [ ] Decisions table renders the per-txn match log.
- [ ] Permissions work: a user without `agents.reconciliation.run` cannot trigger a run.
- [ ] Audit log shows the action.
- [ ] `MASTRA_INTEGRATION_TOKEN` is read from env, missing token in prod causes a clear error.

---

## Files / paths to reference while building (in this order)

1. `backend/src/modules/kyc/index.ts` — module export shape
2. `backend/src/modules/kyc/routes/kyc.routes.ts` — route mounting + middleware pattern
3. `backend/src/modules/kyc/controllers/cpv.controller.ts` — auth, RBAC, audit pattern
4. `backend/src/modules/kyc/services/statfin.service.ts` — external HTTP client pattern (mirror this for `mastra-client.service.ts`)
5. `backend/src/migrations/010_cpv_cases.sql` — table migration pattern
6. `backend/src/migrations/011_kyc_module_seed.sql` — RBAC seed pattern
7. `src/modules/kyc/manifest.json` — frontend manifest shape
8. `src/modules/kyc/services/cpvApiService.ts` — frontend service pattern
9. `src/modules/kyc/pages/CPVDashboard.tsx` — dashboard page pattern (list + filters)
10. `src/modules/kyc/pages/CPVDetail.tsx` — detail page pattern
11. The Mastra service `INTEGRATION.md` (in the Mastra repo) — exact endpoint shapes + payloads

---

## Things explicitly out of scope for v1

- Browser-direct calls to Mastra (CORS) — backend-proxy is the v1 pattern.
- Real-time push (webhooks from Mastra → OpenArc). Polling works for now.
- Multi-tenant token rotation. One shared token for v1.
- Mastra Studio embedded inside OpenArc. Operators still go to `localhost:4111` for dev.
