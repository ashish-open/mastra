# Mastra Integration Surface

Endpoints external apps (OpenArc, future others) use to integrate with this Mastra service.

---

## Auth model

Two layers:

1. **Built-in workflow endpoints** (`/api/workflows/*`) — currently open. Mastra Studio uses these. In production, **put a reverse proxy in front that enforces auth** before exposing the Mastra service publicly.

2. **`/integration/*` endpoints** — protected by a shared bearer token via the `MASTRA_INTEGRATION_TOKEN` env var. If unset, the routes are open (dev). Generate one with `openssl rand -hex 32` and set it in both Mastra and the calling service.

```
Authorization: Bearer <MASTRA_INTEGRATION_TOKEN>
```

---

## Discovery

### `GET /integration/info`

Returns the list of workflows, agents, and reco configs registered in this Mastra instance. Use it at OpenArc startup to populate menus/modules.

**Response:**
```json
{
  "version": "1.0.0",
  "workflows": [
    {
      "id": "reconcileWorkflow",
      "name": "Statement Reconciliation",
      "description": "...",
      "inputSchema": { "configId": "string", "date": "YYYY-MM-DD" },
      "startEndpoint": "POST /api/workflows/reconcileWorkflow/start-async"
    },
    ...
  ],
  "agents": [
    { "id": "knowledgeAgent", "name": "Knowledge Bot", "model": "gpt-4o-mini" },
    ...
  ],
  "reconciliation": {
    "configs": [
      { "id": "bank-pg-internal", "name": "Bank ↔ PG ↔ Internal", "sources": ["internal", "pg-zwitch", "bank"] },
      { "id": "restaurant-swiggy", "name": "Restaurant POS ↔ Swiggy ↔ Bank", "sources": ["pos", "swiggy", "bank"] }
    ],
    "listRunsEndpoint": "GET /integration/reco/runs",
    "listDecisionsEndpoint": "GET /integration/reco/runs/:runId/decisions"
  },
  "authRequired": true
}
```

---

## Workflows

Mastra exposes every workflow as an HTTP endpoint automatically. See `GET /integration/info` for the current list.

### Start a workflow (async, returns immediately)

```
POST /api/workflows/<workflowId>/start-async
Content-Type: application/json

{ "inputData": { "configId": "bank-pg-internal", "date": "2026-05-13" } }
```

**Response:** `{ "runId": "...", ... }`

### Get run state

```
GET /api/workflows/<workflowId>/runs/<runId>
```

**Response:** the full run, including step results and final output if completed.

### List runs

```
GET /api/workflows/<workflowId>/runs?limit=50
```

### Resume a suspended run

```
POST /api/workflows/<workflowId>/runs/<runId>/resume
Content-Type: application/json

{ "resumeData": { "decisions": [...] } }
```

---

## Reconciliation — dedicated endpoints

These mirror what's in workflow run state but in a flatter shape that's easier for dashboards to consume.

### `GET /integration/reco/runs`

Lists recent reconciliation runs.

```json
{
  "count": 3,
  "runs": [
    { "runId": "reco_axis_2026-05-13_xyz", "date": "2026-05-13", "source": "axis", "state": "completed" },
    ...
  ]
}
```

### `GET /integration/reco/runs/:runId/decisions`

Lists every match decision for one run (the audit log).

```json
{
  "runId": "...",
  "count": 8,
  "decisions": [
    {
      "sourceTxnId": "int_001",
      "targetTxnId": "pg_a01",
      "matchType": "exact",
      "amountDeltaPaise": 0,
      "decidedBy": "system",
      "matcherVersion": "v2.0.0",
      "reasoning": "exact: internal_to_pg (joinKey=merchantRefId)",
      "createdAt": "2026-05-13T19:42:11.001Z",
      "runId": "..."
    },
    ...
  ]
}
```

---

## File uploads (reco)

### `POST /reco/upload`

Parses a bank/PG statement file via the appropriate adapter and returns canonical `NormalizedTxn[]`. Does NOT trigger the workflow — caller reviews the parsed rows first, then invokes `reconcileWorkflow`.

```
multipart/form-data:
  file:      <CSV/XLSX/PDF buffer>
  adapterId: "bank" | "swiggy" | "internal" | ...
  accountId: "axis" | "hdfc" | ...    (optional, adapter-specific)
  date:      "YYYY-MM-DD"
```

---

## CORS

For browser clients (the OpenArc frontend, when calling Mastra directly without a backend proxy), set the `MASTRA_ALLOWED_ORIGINS` env var to a comma-separated list of allowed origins.

Currently the recommended pattern is **backend-proxy**, so the OpenArc backend calls Mastra server-to-server and the browser never touches Mastra. In that mode, CORS isn't needed.

---

## Webhooks (Mastra → caller)

Not yet implemented. Today, callers must poll `GET /api/workflows/<id>/runs/<runId>` until `state === "completed"`.

Planned: a `webhooks` config on each workflow run that POSTs to a configurable URL when state transitions (running → completed / suspended / failed). Until then, poll every 2–5s for short workflows; use `/api/workflows/.../runs/.../watch` (SSE) for long ones.

---

## Quick smoke test from OpenArc backend

```ts
// 1. Discover
const info = await fetch(`${MASTRA_BASE}/integration/info`, {
  headers: { Authorization: `Bearer ${MASTRA_TOKEN}` },
}).then(r => r.json());

// 2. Start a reco run
const start = await fetch(`${MASTRA_BASE}/api/workflows/reconcileWorkflow/start-async`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ inputData: { configId: 'bank-pg-internal', date: '2026-05-13' } }),
}).then(r => r.json());
// → { runId: 'wf_...' }

// 3. Poll for completion
let state;
do {
  await sleep(2000);
  state = await fetch(`${MASTRA_BASE}/api/workflows/reconcileWorkflow/runs/${start.runId}`)
    .then(r => r.json());
} while (state.state === 'running');

// 4. Read the decisions
const decisions = await fetch(`${MASTRA_BASE}/integration/reco/runs/${state.output.runId}/decisions`, {
  headers: { Authorization: `Bearer ${MASTRA_TOKEN}` },
}).then(r => r.json());
```
