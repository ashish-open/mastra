# Claude session onboarding — my-test-agent

This file is the **first thing** future Claude Code sessions on this repo should read.

> Project context: this is the OpenArc AI agents service, built on the Mastra framework. It runs alongside (not inside) the OpenArc dashboard at `/Users/ashish.s/Documents/OpenArc/openarc-dashboard`. OpenArc proxies user requests through its backend to this service.

---

## Read these first

1. **[../README.md](../README.md)** — entry point, what exists, how to run
2. **[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)** — layering, persistence, HTTP surface
3. **[../docs/RECONCILIATION.md](../docs/RECONCILIATION.md)** — biggest subsystem, most likely area for new work
4. **[../docs/AGENTS_AND_WORKFLOWS.md](../docs/AGENTS_AND_WORKFLOWS.md)** — catalog of every agent/workflow
5. **[../INTEGRATION.md](../INTEGRATION.md)** — endpoints OpenArc calls

After those, you have enough context to be useful. Skim, don't deep-read — most details are in code comments.

---

## Repo layout cheat sheet

```
my-test-agent/
├── src/mastra/
│   ├── index.ts                ← Mastra container (read this to see what's wired)
│   ├── agents/                 ← LLM agents
│   ├── workflows/              ← Linear pipelines (excluding reco)
│   ├── reconciliation/         ← Reco subsystem (workflow + adapters + db + agents + evals)
│   ├── routes/                 ← Custom HTTP routes
│   ├── tools/                  ← Shared agent tools
│   ├── knowledge/              ← RAG (embed, ingest, vector store, URL mapping)
│   └── memory/                 ← Per-agent memory profiles
├── docs/                       ← The four detail docs
├── .claude/                    ← This file + Claude settings
├── sample-data/                ← Sample CSVs for testing
├── reco.db                     ← LibSQL — reco runs/decisions/staging (gitignored)
├── knowledge.db                ← LibSQL — RAG vectors (gitignored)
├── mastra.db                   ← Mastra internals (gitignored)
└── .env                        ← Secrets (gitignored)
```

---

## Operational facts

### How to start the service

```bash
pnpm dev                # Mastra Studio at http://localhost:4111
```

The Studio UI is **the** way to inspect runs, agent threads, traces, scorer results. When debugging, always check Studio before guessing.

### How to run the reco eval

```bash
pnpm eval:reco
```

Runs 21 labeled cases through the two LLM agents, prints accuracy headlines. Re-run after any prompt/model change.

### How to trigger a reco from CLI

```bash
TOKEN=$(grep MASTRA_INTEGRATION_TOKEN .env | cut -d= -f2)

# 1) Stage all sources for a config (see docs/RECONCILIATION.md → Staging)
curl -X POST http://localhost:4111/reco/upload \
  -F "file=@bank.csv;type=text/csv" \
  -F "configId=bank-pg-internal" -F "adapterId=bank" -F "accountId=primary" \
  -F "date=2026-05-17"
# ... repeat for each source ...

# 2) Trigger the workflow
curl -X POST http://localhost:4111/api/workflows/reconcileWorkflow/start-async \
  -H "Content-Type: application/json" \
  -d '{"inputData":{"configId":"bank-pg-internal","date":"2026-05-17"}}'

# 3) Inspect decisions
RUN_ID=...
curl http://localhost:4111/integration/reco/runs/$RUN_ID/decisions \
  -H "Authorization: Bearer $TOKEN"
```

### How to type-check + smoke

```bash
npx tsc --noEmit -p .                                 # type-check
pnpm dev                                              # smoke-run
curl http://localhost:4111/integration/info \
  -H "Authorization: Bearer $TOKEN" | jq '.workflows[].id'
```

---

## Conventions

### Code

- **TypeScript strict mode everywhere.** No `any` without an `eslint-disable` comment with a reason.
- **Zod schemas at every boundary.** Workflow step inputs/outputs, tool inputs, agent structured-output — all Zod-validated.
- **`/** ... */` doc comments on every exported function.** First sentence: what it does. Following lines: contracts, invariants, edge cases. Future Claude (and future humans) read these first.
- **Comments explain WHY, not WHAT.** Future-you can read the code; only you know why you wrote it.

### Persistence

- **Money is paise.** Integer. Never float. Convert at the parser boundary and never look back.
- **Dates are `YYYY-MM-DD`.** Normalise at the boundary. The matcher and agents assume this.
- **Idempotency keys.** Every external-facing write (reco run, decision, staged txn) has a deterministic unique key. Re-runs and retries are safe.

### Agents

- **Structured output** for any LLM call whose result feeds another step. Free-text only for terminal user-facing output.
- **Pre-compute deterministic things.** Don't ask the LLM to do arithmetic, date math, or lookups it could get wrong — pass the answer in the prompt.
- **Resource-scope memory** is usually what you want. Thread-scope only for ephemeral chats.

### Workflows

- **Steps log their own narrative.** `[reco] Fuzzy ran on 6 txns (parallel × 8)` style. Lets you tail the dev log and follow the story.
- **Each step is independently testable.** Pure inputs, pure outputs, no global side-effects beyond the explicit persistence call.
- **Fail loudly with actionable messages.** Bad: `throw new Error('missing data')`. Good: `Cannot start reconciliation: no data available for source(s) [bank]. Upload via POST /reco/upload, or set RAZORPAY_KEY_ID for live fetch.`

---

## Things to avoid

| Don't | Why |
|---|---|
| Add a new top-level dir under `src/mastra/` without a clear concern | Layering exists. New stuff usually fits in `agents/`, `workflows/`, `routes/`, `tools/`, or under a subsystem dir like `reconciliation/`. |
| Skip the staging table for reco uploads | Replayability + idempotency depend on it. Never parse-and-run-in-one-step. |
| Share tables between `mastra.db` and our own DBs | Mastra owns its DB; sharing risks migration collisions on framework upgrades. |
| Hardcode workflow IDs in OpenArc | Use `/integration/info` for discovery. OpenArc should never have a hard-coded list of "available agents". |
| Auto-reply to customers from the support triage agent | We always default to private note. Read [docs/AGENTS_AND_WORKFLOWS.md](../docs/AGENTS_AND_WORKFLOWS.md#why-we-dont-auto-reply) before changing this. |
| Roll your own match strategy | Three exist (`exact`, `amount_tolerance`, `sum_then_match`). Adding a fourth needs a real reason + tests; configuration usually covers the case. |

---

## Common tasks → where to look

| Task | Files |
|---|---|
| **Add a new reco platform** | [docs/RECONCILIATION.md → Adding a new adapter](../docs/RECONCILIATION.md#adapters); pattern in `adapters/swiggy.ts` |
| **Add a new reco config (combining existing adapters)** | `reconciliation/configs.ts → ensureConfigsRegistered()` |
| **Tweak the fuzzy match prompt** | `reconciliation/agents.ts → fuzzyMatchAgent.instructions`; then re-run `pnpm eval:reco` |
| **Tweak the disposition rules** | `reconciliation/agents.ts → dispositionAgent.instructions`; re-run eval |
| **Add a new agent** | [docs/AGENTS_AND_WORKFLOWS.md → How to add a new agent](../docs/AGENTS_AND_WORKFLOWS.md#how-to-add-a-new-agent) |
| **Add a new workflow** | [docs/AGENTS_AND_WORKFLOWS.md → How to add a new workflow](../docs/AGENTS_AND_WORKFLOWS.md#how-to-add-a-new-workflow) |
| **Expose a new endpoint to OpenArc** | `routes/integration.ts`; update `INTEGRATION.md` |
| **Rebuild the knowledge base** | `pnpm ingest`; sources are in `knowledge/ingest.ts` |
| **Debug a workflow run** | Mastra Studio → Traces tab → click the run id |
| **Inspect persisted reco data** | `sqlite3 reco.db` then `.tables`, `SELECT * FROM reco_decisions WHERE run_id = '...'` |

---

## When you're stuck

1. **Read the relevant doc.** They're more detailed than they look.
2. **Read the code comments.** Every exported function has a contract comment.
3. **Open Mastra Studio.** Traces show every LLM call, every tool call, every step output.
4. **Inspect the DB directly.** `sqlite3 reco.db` is your friend for "did the data make it in?" questions.
5. **Run the eval.** `pnpm eval:reco` answers "did my prompt change break things?" in 10 seconds.

### Common gotcha: "Could not set lock on file mastra.duckdb"

A stale Mastra process from a previous `pnpm build && pnpm start` (running
`.mastra/output/index.mjs`) holds the DuckDB lock. Symptoms:

- `pnpm dev` starts on `:4112` instead of `:4111` (port-collision fallback)
- Then crashes with `IO Error: Could not set lock on file ".../mastra.duckdb"`
- OpenArc gets 502 because it expects `:4111`

Fix:

```bash
# find the holder
ps aux | grep '\.mastra/output/index\.mjs' | grep -v grep
# kill it (replace PID)
kill <PID>
# restart
pnpm dev
```

Prevention: always stop the previous run (Ctrl-C properly) before starting
another. Production builds and dev server can't both run at once because they
share the same DuckDB file.

---

## A note on style

This codebase favours **explicit over clever**. Long descriptive function names, explicit type imports, no metaprogramming, no dynamic dispatch beyond the two adapter/config registries. If you find yourself reaching for `eval`, `Function()`, or a class hierarchy more than 2 levels deep, you've probably gone wrong.

The reco subsystem in particular is built for surgical extension: add an adapter file, add a config entry, ship. The workflow + matcher don't change. Preserve that pattern when adding new platforms.
