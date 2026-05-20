# Architecture

How this service is layered, where things live, why the boundaries are where they are.

---

## Mental model

This service is a **headless agent runtime**. The OpenArc dashboard is its only user-facing surface; OpenArc proxies user requests through its own backend so the browser never talks to Mastra directly.

```
   Browser (OpenArc UI)
        │
        ▼
   OpenArc backend  ──┐
   (auth + RBAC +     │  /integration/*           HTTP, Bearer token
    audit + mirror    │  /api/workflows/*/start
    tables)           │  /reco/upload, /reco/fetch
                      ▼
                ┌───────────────────────────────────────────────┐
                │           Mastra service (this repo)           │
                │                                               │
                │   ┌──────────────┐   ┌──────────────────┐   │
                │   │  Workflows   │──▶│   Agents (LLM)   │   │
                │   │  (Mastra)    │   │ ── tool calls ──▶│   │
                │   └──────┬───────┘   └──────────────────┘   │
                │          │                                  │
                │          ▼                                  │
                │   ┌──────────────────────────────────────┐ │
                │   │  Persistence                          │ │
                │   │   • mastra.db    Mastra internals    │ │
                │   │   • reco.db      reco runs + decisions│ │
                │   │   • knowledge.db RAG vectors          │ │
                │   └──────────────────────────────────────┘ │
                │                                               │
                │   External:                                   │
                │   • OpenAI (gpt-4o / gpt-4o-mini)             │
                │   • Recall.ai (meeting bot)                   │
                │   • Freshdesk (support triage)                │
                │   • Razorpay / Cashfree MCP (reco fetch)      │
                │   • zwitch-mcp (Zeus + knowledge bot)         │
                └───────────────────────────────────────────────┘
```

---

## Layering

| Layer | Responsibility | Lives in |
|---|---|---|
| **Routes** | HTTP surface — discovery, file uploads, webhooks | `src/mastra/routes/` |
| **Workflows** | Multi-step pipelines orchestrated by `@mastra/core` | `src/mastra/workflows/`, `src/mastra/reconciliation/workflow.ts` |
| **Agents** | LLM units that take inputs + tools → produce structured output | `src/mastra/agents/`, `src/mastra/reconciliation/agents.ts` |
| **Tools** | Pure functions (HTTP clients, validators) exposed to agents | `src/mastra/tools/` |
| **Adapters** (reco-specific) | Source-format parsers — produce canonical `NormalizedTxn[]` | `src/mastra/reconciliation/adapters/` |
| **Persistence** | LibSQL DBs (one per concern), Postgres for merchant ledger | `src/mastra/reconciliation/db.ts`, `src/mastra/knowledge/vector.ts` |
| **Knowledge** | RAG: chunk, embed, search, URL map | `src/mastra/knowledge/` |
| **Memory** | Per-agent thread + working-memory templates | `src/mastra/memory/` |
| **Evals** | Labeled dataset + scorers + runner | `src/mastra/reconciliation/evals/` |

**One Mastra container** (`src/mastra/index.ts`) wires everything together: workflows, agents, scorers, custom HTTP routes, storage, observability. Mastra exposes every registered workflow as `POST /api/workflows/<id>/start-async` automatically — we don't write per-workflow routes.

---

## Boundaries that matter

### 1. **LLMs decide; code computes.**
Anything that has to be deterministic (idempotency, audit, money arithmetic, joining on UTR) is **plain TypeScript** in `tools.ts`, `matcher.ts`, `db.ts`. LLMs only run on ambiguous residuals (fuzzy match, disposition, summarisation). Both reco LLM agents are gpt-4o-mini — small models for small judgment calls.

### 2. **Staging is the source of truth for reco runs.**
Reco workflows never re-read CSVs at run time. The upload route parses → stores in `reco_staged_transactions`. The workflow reads from staging. Re-uploading invalidates prior completed runs (marks them `'superseded'`). This means re-runs are deterministic and replayable.

### 3. **Idempotency is in two places.**
- `reco_runs` table: UNIQUE(date, source). If a completed run exists for the slot, the workflow short-circuits with `skipped: true`. New uploads bump it to `'superseded'` so the next run starts fresh.
- `dbWriteRecoDecisions` deletes prior decisions for a `runId` before re-inserting. Retrying a failed step doesn't duplicate decisions.

### 4. **Three separate DBs.**
- `mastra.db` — Mastra's own internals (workflow state, agent threads, tool-call traces). Managed by Mastra core.
- `reco.db` — Our reco-specific tables (`reco_runs`, `reco_decisions`, `reco_staged_transactions`).
- `knowledge.db` — LibSQL vector store for RAG.

This is deliberate. Mastra owns its DB and migrates it across versions; if we shared tables, version upgrades could collide.

### 5. **Tool calls vs workflow steps.**
- **Workflow steps** (`createStep`) are deterministic orchestration: "fetch from these sources, then run the match graph, then call this agent." Steps have input/output schemas validated at the boundary.
- **Tools** (`createTool`) are agent-callable. An agent decides whether and when to invoke them.

Both can call the same business logic (`tools.ts`, `db.ts`). The distinction is who triggers it: the workflow author or the LLM.

---

## Persistence layout

### `reco.db` (LibSQL — single file, SQLite-compatible)

```sql
reco_runs              -- one row per (config_id, date) reconciliation execution
  id            PK     -- e.g. reco_bank-pg-internal_2026-05-17_1779050947835
  date                 -- YYYY-MM-DD
  source               -- the configId, e.g. 'bank-pg-internal'
  state                -- 'open' | 'completed' | 'superseded' | 'failed'
  created_at, updated_at
  UNIQUE INDEX (date, source)

reco_decisions         -- the per-txn match outcome
  id              PK
  run_id          FK → reco_runs.id ON DELETE CASCADE
  source_txn_id        -- the unmatched/matched txn's sourceId
  target_txn_id        -- nullable; the candidate it matched to
  match_type           -- 'exact' | 'fuzzy_auto' | 'fuzzy_human' | 'pending_review'
                       --   | 'unmatched' | 'written_off' | 'flagged_fraud'
  amount_delta_paise   -- 0 for exact; small for fuzzy_auto
  decided_by           -- 'system' or a user id
  matcher_version      -- 'v2.0.0' — bump on matcher logic changes
  reasoning            -- LLM rationale for fuzzy/disposition decisions
  created_at

reco_staged_transactions  -- parsed-but-not-yet-reconciled rows
  id            PK
  config_id            -- which reco config this slot belongs to
  adapter_id           -- which source within the config
  date                 -- the reco date
  source_id            -- the txn's sourceId (for idempotent upsert)
  payload              -- full NormalizedTxn JSON
  uploaded_at, uploaded_by, filename
  UNIQUE INDEX (config_id, adapter_id, date, source_id)
```

### `mastra.db` + observability

Managed by Mastra. Holds workflow run state, message history per agent thread, observability spans/traces. Read via Mastra Studio (`http://localhost:4111`).

### `knowledge.db`

LibSQL vector index for RAG (`@mastra/libsql` + `@mastra/rag`). Built from markdown files in `/Users/ashish.s/Documents/AgentX/Agent_X/knowledge_base/openmoney` and `Optotax-*.md` files in this repo. Rebuild with `pnpm ingest`.

---

## HTTP surface

| Route | Purpose | Auth |
|---|---|---|
| `/api/workflows/<id>/start-async` | Generic Mastra workflow start | None (reverse-proxy in prod) |
| `/api/workflows/<id>/runs/:runId` | Poll a workflow run | Same |
| `/integration/info` | Discovery — list workflows/agents/configs | Bearer token |
| `/integration/reco/runs` | List recent reco runs | Bearer token |
| `/integration/reco/runs/:runId/decisions` | Audit log for one run | Bearer token |
| `/reco/upload` | Upload + parse + stage a statement CSV | None (proxied via OpenArc) |
| `/reco/staged` | What's been staged for (config, date) | None |
| `/reco/fetch` | Live-fetch from an adapter that has `.fetch()` | None |
| `/recall/webhook` | Recall.ai meeting-event callbacks | Recall signature |
| `/freshdesk/webhook` | Freshdesk ticket-event callbacks | Source-IP allowlist |
| `/reco/mcp/razorpay/{test,seed}` | Test the Razorpay MCP connector | None (dev only) |

The `/integration/*` token check lives in `routes/integration.ts:checkToken`. If `MASTRA_INTEGRATION_TOKEN` is unset, the routes are open (dev). Production should always set it.

---

## Why TypeScript + a single-process Node service

We picked Mastra because:
- Native TypeScript with proper types end-to-end (workflow steps have typed input/output schemas)
- Built-in workflow engine with `.then() / .branch() / .parallel() / suspend()`
- Studio UI gives us free observability + trace inspection
- Free conversion of every workflow to an HTTP endpoint

The trade-offs are:
- Long-running async work depends on the Node process staying up (mitigated by Mastra's internal queue + storage-backed workflow state)
- No multi-tenant isolation at the runtime layer — OpenArc enforces that

---

## Observability

Every workflow + agent run produces traces via `@mastra/observability`:
- `DefaultExporter` persists to LibSQL → visible in Mastra Studio's Traces tab
- `CloudExporter` ships to Mastra Cloud if `MASTRA_CLOUD_ACCESS_TOKEN` is set
- `SensitiveDataFilter` redacts secrets from spans

Per-step `console.log` lines are deliberate — they give you a human-readable narrative in the dev terminal even when you can't open Studio. Pattern:
```
[reco] source pg-zwitch: 5 txns (staged)
[reco-match:internal_to_pg] from=internal to=pg-zwitch matched=3 leftResidual=2 rightResidual=2
[reco] Deterministic: exact=3, unmatched=6
[reco] Fuzzy ran on 6 txns (parallel × 8)
[reco] Disposition: total=9, humanReview=6, noMatch=1
[reco] Run reco_… complete: { exact: 3, fuzzyAuto: 0, ... }
```
