# Reconciliation subsystem

Deep dive on `src/mastra/reconciliation/` — what each piece does, how they connect, how to extend it.

> Start with [ARCHITECTURE.md](ARCHITECTURE.md) for the big picture. This doc assumes you've read that.

---

## The 30-second mental model

A reconciliation **config** declares: "for this kind of reco, we use these N sources, and here's the graph of matches between them." A **run** picks one config + one date, gathers data for every source (from staging or live fetch), walks the match graph deterministically, hands the residual to two LLM agents for judgment, and writes everything to an audit log.

```
       ┌─────────────────────────────────────────────────────┐
       │                ReconcileConfig                       │
       │  sources: [internal, pg-zwitch, bank]                │
       │  matches: [                                          │
       │    internal_to_pg  (exact, joinKey=merchantRefId)    │
       │    pg_batch_to_bank (sum_then_match, joinKey=utr)    │
       │  ]                                                   │
       └────────────────────┬────────────────────────────────┘
                            │
            ┌───────────────┴──────────────┐
            │                              │
            ▼                              ▼
       SourceAdapter[]              MatchStrategy[]
       (parse files / fetch         (deterministic
        APIs into                    code; emit
        NormalizedTxn[])             RecoDecisions)
            │                              │
            └───────────────┬──────────────┘
                            │
                            ▼
                  ┌───────────────────────┐
                  │ Workflow (7 steps)    │
                  │  1. open-reco-run     │  ← idempotent
                  │  2. fetch-all-sources │  ← staging first, then fetch()
                  │  3. deterministic-    │  ← runs match graph
                  │     match             │
                  │  4. fuzzy-match       │  ← LLM (residual)
                  │  5. disposition       │  ← LLM (per-case decision)
                  │  6. review-gate       │  ← surfaces human-review cases
                  │  7. write-decisions   │  ← audit log
                  └───────────────────────┘
```

---

## The core types

**[`types.ts`](../src/mastra/reconciliation/types.ts)** defines four canonical shapes — every adapter, matcher, and agent speaks these.

```ts
NormalizedTxn = {
  sourceId       string  // unique within the source
  source         'internal' | 'pg' | 'bank'
  amountPaise    integer (NEVER use floats for money)
  date           'YYYY-MM-DD'
  utr            string | null         // bank reference
  merchantRefId  string | null         // our order id
  settlementId   string | null         // PG batch grouping
  description, counterparty, raw
}

MatchType = 'exact'           // 1:1, amounts EQUAL on shared joinKey
          | 'tolerance_match' // 1:1 with allowed delta (commission/fee/GST)
          | 'batch_match'     // N:1 — many source txns settle as one bank credit
          | 'fuzzy_auto' | 'fuzzy_human' | 'pending_review'
          | 'unmatched' | 'written_off' | 'flagged_fraud'

// Customer-facing display labels live in MATCH_TYPE_LABELS (types.ts), exposed
// at GET /integration/info → reconciliation.matchTypeLabels so OpenArc renders
// "Matched (batched)" / "Matched (with fee)" / "Needs review" etc. directly
// from the API instead of mapping enum values to strings client-side.

RecoDecision = {
  sourceTxnId, targetTxnId, matchType, amountDeltaPaise,
  decidedBy, matcherVersion, reasoning,
  metadata?: { strategyName?, batchId?, batchSize?, batchSumPaise?,
               expectedPaise?, tolerancePaise? }
}

FuzzyMatchResult = {
  unmatchedSourceId,
  bestCandidate: { candidateTxnId, similarityScore, reasoning } | null,
  alternatives: [...]
}

Disposition = {
  sourceTxnId, recommendation: 'auto_match' | 'human_review' | 'write_off' | 'flag_fraud',
  targetTxnId, confidence: 'high' | 'medium' | 'low', reasoning
}
```

**Key invariants:**
- Amounts are **always integer paise**. Convert at the parser boundary.
- `sourceId` is the upstream's ID, prefixed by adapter (e.g. `int_42`, `swiggy_SW-2026-001`, `bank_axis_3_AXISN001`). Uniqueness within a source is required; uniqueness across sources is recommended.
- Marketplace `amountPaise` is the **net** payout (after commission/GST/TCS) — the gross belongs in `raw`.

---

## Adapters

**[`adapter.ts`](../src/mastra/reconciliation/adapter.ts)** defines the `SourceAdapter` interface. Each adapter knows ONE format and outputs `NormalizedTxn[]`.

```ts
interface SourceAdapter {
  id:    string   // 'bank', 'pg-zwitch', 'swiggy', ...
  name:  string
  kind:  'internal' | 'pg' | 'bank' | 'marketplace' | 'erp' | 'tax' | 'logistics'

  fetch?(ctx):      Promise<NormalizedTxn[]>   // live API / DB
  parseFile?(buf, mime, ctx): Promise<NormalizedTxn[]>  // upload path
}
```

Most adapters implement **one** of the two methods:
- **Live fetch** when the upstream has a usable API (Razorpay, Cashfree, Postgres ledger).
- **Upload only** when the upstream sends CSVs by email or download (banks, Swiggy, Zomato, Zepto, Tally).

Both are deliberate — Indian banks don't expose daily-statement APIs, so for banks we don't pretend.

### Current adapters

| File | id | Mode | Notes |
|---|---|---|---|
| `adapters/internal-ledger.ts` | `internal` | fetch (Postgres) + parseFile (CSV) | Driven by `MERCHANT_DB_URL` + `MERCHANT_LEDGER_QUERY` envs. Falls back to CSV if no DB. |
| `adapters/pg-zwitch.ts` | `pg-zwitch` | parseFile only | Zwitch settlement CSV. |
| `adapters/pg-razorpay.ts` | `pg-razorpay` | fetch (MCP) + parseFile | Live fetch when `RAZORPAY_KEY_ID` is set, else upload. |
| `adapters/pg-cashfree.ts` | `pg-cashfree` | fetch (MCP) + parseFile | Same pattern, with `CASHFREE_APP_ID`. |
| `adapters/bank-statement.ts` | `bank` | parseFile only | Canonical CSV with date/amount/utr/description/counterparty. Handles credit+debit columns separately. |
| `adapters/swiggy.ts` | `swiggy` | parseFile only | 22% commission + 18% GST + 1% TCS formula. |
| `adapters/zomato.ts` | `zomato` | parseFile only | 25% commission + 18% GST + 1% TCS. |
| `adapters/zepto.ts` | `zepto` | parseFile only | 18% commission + 18% GST + 1% TCS. |
| `adapters/erp-tally.ts` | `erp-tally` | parseFile only | AR invoices; default 10% TDS, overridable per row. |
| `adapters/pos.ts` | `pos`, `pos-zomato`, `pos-zepto` | parseFile only | Restaurant POS feed; three variants because match graphs differ per platform. |

### Adding a new adapter

1. Create `adapters/your-platform.ts`:

```ts
import type { SourceAdapter } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';

export const yourPlatformAdapter: SourceAdapter = {
  id: 'your-platform',
  name: 'Your Platform',
  kind: 'marketplace',  // or 'pg', 'bank', etc.

  async parseFile(file, mime, ctx) {
    // Parse the file → return NormalizedTxn[]
    // Reuse splitCSVLine / normalizeDate helpers (see other adapters)
  },
};

// Export a commission-deduction helper if the platform takes a cut.
export function yourPlatformExpectedNetPaise(grossPaise: number): number {
  const commission = grossPaise * 0.20;   // 20%
  const gst = commission * 0.18;
  const tcs = grossPaise * 0.01;
  return Math.round(grossPaise - commission - gst - tcs);
}
```

2. Register it in `configs.ts → ensureConfigsRegistered()`:

```ts
import { yourPlatformAdapter, yourPlatformExpectedNetPaise } from './adapters/your-platform.js';

registerAdapter(yourPlatformAdapter);
```

3. Add a config that uses it (see next section).

---

## Configs (match graphs)

**[`configs.ts`](../src/mastra/reconciliation/configs.ts)** registers every adapter + every `ReconcileConfig`. A config is a declarative match graph.

```ts
registerConfig({
  id: 'your-config',
  name: 'Your Platform ↔ Bank',
  description: '...',
  sources: [
    { adapterId: 'your-platform' },
    { adapterId: 'bank', accountId: 'your-bank-account' },
  ],
  matches: [
    {
      name: 'platform_batch_to_bank',
      from: 'your-platform',
      to:   'bank',
      strategy: 'sum_then_match',
      joinKey:    'utr',
      aggregateBy: 'settlementId',
      tolerancePaise: 0,
    },
  ],
});
```

### Match strategies

**[`matcher.ts`](../src/mastra/reconciliation/matcher.ts)** implements three:

| Strategy | What it does | Emits `matchType` | When to use |
|---|---|---|---|
| `exact` | 1:1 join on `joinKey`; amounts must be EQUAL | `exact` | Internal ledger ↔ PG (your `order_id`) |
| `amount_tolerance` | 1:1 join; allow `±tolerancePaise` delta OR run through `expectedNetPaise(gross)` first | `tolerance_match` (carries `expectedPaise` + `tolerancePaise` in metadata) | POS ↔ Swiggy/Zomato (commission deduction); ERP ↔ bank with TDS |
| `sum_then_match` | Group LEFT by `aggregateBy` (e.g. `settlementId`), sum, match to RIGHT amount | `batch_match` (carries `batchId`, `batchSize`, `batchSumPaise` in metadata) | PG batch ↔ bank credit (N:1 aggregation) |

Matches run **in declaration order**. Each match "consumes" matched rows from both pools — subsequent matches only see the residual. Whatever's left after the last match is the **residual** that flows to LLM fuzzy matching.

### Current configs

| Config id | Topology | Match strategies |
|---|---|---|
| `bank-pg-internal` | internal ↔ pg-zwitch ↔ bank | exact(refId), sum_then_match(utr) |
| `bank-pg-razorpay` | pg-razorpay ↔ bank | sum_then_match(utr) |
| `bank-pg-cashfree` | pg-cashfree ↔ bank | sum_then_match(utr) |
| `restaurant-swiggy` | pos ↔ swiggy ↔ bank | amount_tolerance(refId, swiggyExpectedNet), sum_then_match(utr) |
| `restaurant-zomato` | pos-zomato ↔ zomato ↔ bank | amount_tolerance(refId, zomatoExpectedNet), sum_then_match(utr) |
| `restaurant-zepto` | pos-zepto ↔ zepto ↔ bank | amount_tolerance(refId, zeptoExpectedNet), sum_then_match(utr) |
| `erp-bank-tally` | erp-tally ↔ bank | amount_tolerance(refId, tallyExpectedNet) |

---

## The workflow

**[`workflow.ts`](../src/mastra/reconciliation/workflow.ts)** — 7 steps:

| Step | Code (no LLM) or LLM? | What |
|---|---|---|
| 1. `open-reco-run` | Code | Idempotent insert into `reco_runs`. If a `completed` row exists for (date, configId), short-circuits with `skipped: true`. |
| 2. `fetch-all-sources` | Code | For each source in the config: read from staging; if empty AND adapter has `fetch()`, call it AND persist back to staging; if still empty, fail with a precise "upload first" error. |
| 3. `deterministic-match` | Code | Walks `config.matches`. Emits `exact` / `tolerance_match` / `batch_match` decisions, leaves residual unmatched. |
| 4. `fuzzy-match` | **LLM** (gpt-4o-mini, 8x concurrent) | For each unmatched txn, asks `fuzzyMatchAgent` to pick the best candidate from the pool (or null). |
| 5. `disposition` | **LLM** (gpt-4o-mini, 8x concurrent) | For each fuzzy result + the original source txn, asks `dispositionAgent` to decide: `auto_match` / `human_review` / `write_off` / `flag_fraud`. Today's date + `daysOld` are pre-computed and passed in. |
| 6. `review-gate` | Code | Surfaces `human_review` cases. TODO: wire suspend()/resume() for an ops-dashboard approval loop. |
| 7. `write-decisions` | Code | One transaction: delete prior decisions for runId, insert all new ones, mark run as `completed`. |

**Trigger from Studio:**
```json
POST /api/workflows/reconcileWorkflow/start-async
{ "inputData": { "configId": "bank-pg-internal", "date": "2026-05-17" } }
```

**Failure modes the workflow guards against:**

| Failure | Behavior |
|---|---|
| Missing source data | Step 2 throws with `Cannot start reconciliation: no data available for source(s) [bank]` |
| Duplicate run on same (date, configId) | Step 1 returns `alreadyCompleted: true`; later steps no-op |
| Fresh upload after a completed run | Upload route marks prior runs as `'superseded'`; next run starts clean |
| Adapter API timeout | Step 2 logs the error and adds the adapter to `missing[]`; throws once the full list is built (one error tells the operator everything that's wrong) |
| LLM rate limit / 5xx | Mastra's built-in retries handle transient errors; persistent failures propagate up |
| Partial decision write | Step 7 runs inside a transaction — either all decisions land or none do |

---

## The two LLM agents

**[`agents.ts`](../src/mastra/reconciliation/agents.ts)** — both gpt-4o-mini, both with structured-output schemas.

### `fuzzyMatchAgent`

Input: one unmatched txn + a candidate pool (other sources, capped to 20 rows). Output: `FuzzyMatchResult` — best candidate (or null) + up to 3 alternatives, each scored 0..1 with text reasoning.

Scoring rubric in the prompt:
- 0.95+: amount delta < 0.1% + counterparty matches + refId/UTR overlap
- 0.85–0.95: 2 of 3 signals match
- 0.5–0.85: weak signals
- < 0.5: don't match — return null

### `dispositionAgent`

Input: fuzzy result + the original txn + `daysOld` (pre-computed). Output: `Disposition` — one of four recommendations with confidence + reasoning.

The matrix is **ordered**; the agent stops at the first rule that fires:

1. **flag_fraud** — at least 2 of {round-number unrecognised counterparty, "UNKNOWN" / generic counterparty, malformed UTR, laundering-pattern description, repeated identical txns}
2. **auto_match** — bestCandidate.similarityScore ≥ 0.95 AND amount delta < 1% AND same counterparty AND not refund-shaped AND no fraud signals
3. **write_off** — bestCandidate null OR score < 0.4 AND amount < ₹1,000 AND daysOld ≥ 30 AND no fraud signals
4. **human_review** — everything else (default)

We deliberately tightened rules 1 + 3 after the eval surfaced over-flagging. Current accuracy: 100% on the 10-case disposition eval (see [evals](#evals)).

### Confidence-graded short-circuit (Plan B#1)

`dispositionStep` skips the LLM call entirely when the fuzzy result is decisive:

- `similarityScore ≥ 0.95` AND positive amount AND named non-generic counterparty → straight to `fuzzy_auto` (no LLM)
- Otherwise → LLM disposition path

Saves ~20-60% of LLM calls per run and removes judgment variance on clearly-matching pairs. The threshold is conservative (0.95 not 0.9) because the LLM's main value is fraud-signal detection — we only skip when no fraud signals could possibly fire. Refunds (negative amounts) and unknown-counterparty cases always go through the LLM.

### Per-config rule sheets (Plan B#3)

A reco config can ship `src/mastra/reconciliation/rules/<configId>.md`. The disposition step reads it via [`rules/loader.ts`](../src/mastra/reconciliation/rules/loader.ts) and appends it to the LLM prompt under `## Config-specific rules`, layered on top of the universal matrix.

Use this to encode platform-specific quirks without code changes:

- **Fee model** — "Swiggy deducts ~28% of gross; don't flag as fraud"
- **Settlement cadence** — "Razorpay settles T+2; daysOld ≤ 4 is in-window, not write-off material"
- **Per-platform thresholds** — "Use ₹500 / 14 days for Swiggy write-off, not the global ₹1,000 / 30 days"
- **Shape exceptions** — "Don't flag NEFT-RAZORPAY rows as fraud just because amount is round"

See [`rules/README.md`](../src/mastra/reconciliation/rules/README.md) for authoring guidance + starter sheets for `bank-pg-razorpay` and `restaurant-swiggy`. Edit the `.md` file, restart `pnpm dev`, run the workflow — no code deploy.

---

## Staging (uploaded data lifecycle)

**[`db.ts`](../src/mastra/reconciliation/db.ts) → `reco_staged_transactions` table.**

Why a staging table instead of "parse on every run":
- **Replayability** — a run reads the exact bytes from staging, not from a fresh re-parse of a file that might have been overwritten or moved.
- **Multi-source coordination** — restaurants upload Swiggy CSV at 8am, the bank statement arrives at 5pm. Staging lets each upload land independently before the workflow runs.
- **Idempotency** — re-uploading the same statement replaces under the unique constraint `(config_id, adapter_id, date, source_id)`. No double-count.
- **Invalidation** — uploading new data flips any prior completed runs for that (config, date) to `'superseded'`, so the next workflow run sees fresh state.

### Lifecycle

```
   ┌──────────────────┐
   │ User uploads CSV │
   └─────────┬────────┘
             │  POST /reco/upload
             ▼
   ┌─────────────────────┐
   │ adapter.parseFile() │  → NormalizedTxn[]
   └─────────┬───────────┘
             │
             ▼
   ┌─────────────────────────────────────┐
   │ INSERT INTO reco_staged_transactions │
   │   (config_id, adapter_id, date, ... ) │
   │ ─ UPSERT under unique constraint     │
   │ ─ UPDATE reco_runs SET state =      │
   │     'superseded' for this slot      │
   └─────────────────────────────────────┘
             │
             ▼
   ┌─────────────────────────────────────┐
   │ Workflow run: read staged rows for   │
   │ every source in config.sources       │
   └─────────────────────────────────────┘
```

### Upload helper routes

| Route | Purpose |
|---|---|
| `POST /reco/upload` | Multipart upload. Validates config + adapter, parses, stages, returns preview + `missingAdapters[]` for the UI. |
| `GET /reco/staged?configId=…&date=…` | "Which sources are ready?" — used by the dashboard to enable the "Run reco" button. |
| `POST /reco/fetch` | Body `{configId, adapterId, date}` — for adapters with `.fetch()`, pulls live data and stages it. |
| `DELETE /reco/staged?…` | Admin: clear one slot to re-upload from scratch. |

---

## Evals

**[`evals/`](../src/mastra/reconciliation/evals/)** — labeled dataset + scorers + CLI runner.

### Dataset (`dataset.ts`)

21 hand-built cases covering 10 categories: exact_match, amount_rounding, counterparty_alias, commission_deduct, refund_chain, orphan_no_candidate, ambiguous_dup, fraud_pattern, small_old_writeoff, wrong_utr_typo.

- 11 fuzzy cases (input: unmatched txn + candidate pool; expected: candidate id or null + score range)
- 10 disposition cases (input: fuzzy result + source txn; expected: recommendation)

### Scorers (`scorers.ts`)

| Scorer | What it measures | Type |
|---|---|---|
| `candidateValidityScorer` | Did the agent pick a candidate ID that actually exists in the pool? | Code (binary 0/1) |
| `dispositionAccuracyScorer` | Did the agent pick the expected recommendation? | Code (binary 0/1) |
| `reasoningQualityScorer` | Does the reasoning text cite real signals (amount delta, counterparty, refId) vs generic phrases? | LLM judge (0/0.5/1) |

### Running

```bash
pnpm eval:reco
```

Runs all 21 cases concurrently against the live agents. Typical output:

```
Candidate Validity   : 100% (11/11)
Best-Candidate Pick  :  91% (10/11)
Reasoning Quality    : 0.97 avg
Disposition Accuracy : 100% (10/10)
Total time: ~11s
```

Re-run after any prompt or model change. Add a row to your changelog if the numbers move materially.

---

## Persistence schema

```sql
-- The audit log — read by OpenArc for the reco dashboard
CREATE TABLE reco_runs (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  source      TEXT NOT NULL,           -- the configId
  state       TEXT NOT NULL,           -- 'open' | 'completed' | 'superseded' | 'failed'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_reco_runs_date_source ON reco_runs(date, source);

CREATE TABLE reco_decisions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL REFERENCES reco_runs(id) ON DELETE CASCADE,
  source_txn_id      TEXT NOT NULL,
  target_txn_id      TEXT,
  match_type         TEXT NOT NULL,    -- see MatchType enum
  amount_delta_paise INTEGER NOT NULL DEFAULT 0,
  decided_by         TEXT NOT NULL,
  matcher_version    TEXT NOT NULL,
  reasoning          TEXT,
  created_at         TEXT NOT NULL
);

-- The staging table — written by /reco/upload, read by the workflow
CREATE TABLE reco_staged_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id     TEXT NOT NULL,
  adapter_id    TEXT NOT NULL,
  date          TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  payload       TEXT NOT NULL,         -- JSON of NormalizedTxn
  uploaded_at   TEXT NOT NULL,
  uploaded_by   TEXT,
  filename      TEXT,
  UNIQUE (config_id, adapter_id, date, source_id)
);
```

`dbListRecoDecisions(runId)` LEFT JOINs the decisions table with the staging table twice (source + target) so the UI gets actual amounts + counterparties in one query.

---

## Reading list

In order of importance:

1. `src/mastra/reconciliation/workflow.ts` — see the 7 steps end-to-end
2. `src/mastra/reconciliation/configs.ts` — declarative match graphs
3. `src/mastra/reconciliation/matcher.ts` — three deterministic strategies
4. `src/mastra/reconciliation/agents.ts` — the two LLM prompts
5. `src/mastra/reconciliation/db.ts` — persistence layer
6. `src/mastra/reconciliation/adapters/swiggy.ts` — a complete adapter with a commission formula
7. `src/mastra/reconciliation/evals/` — what "correct" looks like
