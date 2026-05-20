# OpenArc Agents (Mastra service)

The Mastra-based AI agents and workflows that power OpenArc's internal operations: statement reconciliation, meeting bot, Freshdesk support triage, internal knowledge bot, and agentic payments (Zeus).

This service runs **alongside** the OpenArc dashboard — it exposes HTTP endpoints that the OpenArc backend proxies to. Mastra Studio (`http://localhost:4111`) is the local dev UI; the OpenArc UI is the user-facing front end.

---

## Quick start

```bash
pnpm install
pnpm dev                    # starts Mastra Studio at http://localhost:4111
```

Required env vars (`.env` at the repo root — see `.env` for the full list):

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` | All LLM calls |
| `MASTRA_INTEGRATION_TOKEN` | Bearer token for `/integration/*` routes (OpenArc → Mastra auth) |
| `KNOWLEDGE_DB_URL` | LibSQL URL for the embedded knowledge base (default: `file:./knowledge.db`) |
| `RECO_DB_URL` | LibSQL URL for reco runs / decisions / staging (default: `file:./reco.db`) |
| `RECALL_API_KEY` | Meeting bot — Recall.ai |
| `FRESHDESK_DOMAIN` / `FRESHDESK_API_KEY` | Support triage |
| `ZWITCH_API_KEY` | Zeus (agentic payments) |
| `MERCHANT_DB_URL` | Optional — Postgres for the internal-ledger adapter |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Optional — live Razorpay settlement fetch |
| `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` | Optional — live Cashfree settlement fetch + Cashfree MCP auth |
| `CASHFREE_MCP_URL` / `CASHFREE_MCP_ENV` / `CASHFREE_MCP_TOOLS` | Optional — override Cashfree MCP endpoint, env (`sandbox`/`production`), tool subset (`pg,payouts,secureid`) |

---

## What's in this service

| Surface | Description | Doc |
|---|---|---|
| **Statement Reconciliation** | Upload bank/PG/marketplace CSVs → deterministic match → LLM fuzzy match for the residual → audit log. Config-driven for new platforms. | [docs/RECONCILIATION.md](docs/RECONCILIATION.md) |
| **Meeting Bot** | Recall.ai bot joins a meeting → transcribes → meeting agent summarises → Slack post. | [docs/AGENTS_AND_WORKFLOWS.md](docs/AGENTS_AND_WORKFLOWS.md#meeting-bot) |
| **Support Triage** | Freshdesk webhook → classifies ticket → drafts a private-note L1 reply (never auto-sends). | [docs/AGENTS_AND_WORKFLOWS.md](docs/AGENTS_AND_WORKFLOWS.md#support-triage) |
| **Knowledge Bot** | RAG over Optotax + Open Money KB; live Zwitch docs via the zwitch-mcp server. | [docs/AGENTS_AND_WORKFLOWS.md](docs/AGENTS_AND_WORKFLOWS.md#knowledge-bot) |
| **Zeus (agentic payments)** | Autonomous merchant-card payments via Zwitch + Wibmo, gated by a per-user mandate. | [docs/AGENTS_AND_WORKFLOWS.md](docs/AGENTS_AND_WORKFLOWS.md#zeus) |
| **OpenArc integration** | All of the above exposed via `/integration/*` for the OpenArc dashboard. | [INTEGRATION.md](INTEGRATION.md) |

Architecture overview: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

Onboarding for future Claude Code sessions on this repo: **[.claude/CLAUDE.md](.claude/CLAUDE.md)**.

---

## Common commands

```bash
pnpm dev                    # dev server with hot reload (Mastra Studio at :4111)
pnpm build                  # production build
pnpm start                  # serve the production build
pnpm ingest                 # rebuild the knowledge.db from /knowledge_base markdown
pnpm eval:reco              # run the reconciliation eval dataset (21 cases)
```

### One-liner smoke test

```bash
TOKEN=$(grep MASTRA_INTEGRATION_TOKEN .env | cut -d= -f2)
curl -s http://localhost:4111/integration/info -H "Authorization: Bearer $TOKEN" | jq
```

---

## File layout

```
my-test-agent/
├── src/mastra/
│   ├── index.ts                       ← Mastra container: registers workflows/agents/scorers/routes
│   ├── agents/                        ← LLM agents (meeting, support-triage, knowledge, zeus)
│   ├── workflows/                     ← Linear pipelines (meeting, support-triage)
│   ├── reconciliation/                ← Reco subsystem — see docs/RECONCILIATION.md
│   │   ├── workflow.ts                ← 7-step config-driven workflow
│   │   ├── configs.ts                 ← All ReconcileConfigs + adapter registrations
│   │   ├── adapter.ts                 ← SourceAdapter + ReconcileConfig types + global registry
│   │   ├── adapters/*.ts              ← Per-platform adapters (bank, swiggy, razorpay, …)
│   │   ├── matcher.ts                 ← Deterministic match-graph walker
│   │   ├── agents.ts                  ← LLM agents (fuzzy match + disposition)
│   │   ├── db.ts                      ← LibSQL persistence (runs, decisions, staging)
│   │   ├── tools.ts                   ← Workflow-facing wrappers around db.ts
│   │   ├── types.ts                   ← Canonical schemas (NormalizedTxn, RecoDecision, …)
│   │   └── evals/                     ← Labeled dataset + scorers + runner
│   ├── routes/                        ← Custom HTTP endpoints
│   │   ├── integration.ts             ← /integration/* — OpenArc-facing
│   │   ├── reco-upload.ts             ← /reco/upload, /reco/staged, /reco/fetch
│   │   ├── recall-webhook.ts          ← Recall.ai callbacks
│   │   ├── freshdesk-webhook.ts       ← Freshdesk callbacks
│   │   └── mcp-test.ts                ← Razorpay MCP test utilities
│   ├── tools/                         ← Reusable agent tools (slack, freshdesk, recall, …)
│   ├── knowledge/                     ← RAG embedder + ingest + URL mapper
│   └── memory/                        ← Per-agent memory profiles
├── docs/                              ← Detailed docs (read these)
├── .claude/                           ← Claude Code session onboarding
├── sample-data/                       ← Example bank CSV
└── INTEGRATION.md                     ← OpenArc integration spec (endpoints, auth)
```

---

## Where to start reading the code

If you only have 10 minutes:
1. [`src/mastra/index.ts`](src/mastra/index.ts) — see how the service wires together
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — high-level layering
3. [`src/mastra/reconciliation/workflow.ts`](src/mastra/reconciliation/workflow.ts) — the most complex workflow, with comments

If you're adding a new reco platform:
1. [`docs/RECONCILIATION.md`](docs/RECONCILIATION.md) — adapter pattern
2. [`src/mastra/reconciliation/adapters/swiggy.ts`](src/mastra/reconciliation/adapters/swiggy.ts) — clean reference example

If you're adding a new agent:
1. [`docs/AGENTS_AND_WORKFLOWS.md`](docs/AGENTS_AND_WORKFLOWS.md) — patterns
2. [`src/mastra/agents/knowledge-agent.ts`](src/mastra/agents/knowledge-agent.ts) — simple example
3. [`src/mastra/memory/memory-profiles.ts`](src/mastra/memory/memory-profiles.ts) — per-agent memory configs
