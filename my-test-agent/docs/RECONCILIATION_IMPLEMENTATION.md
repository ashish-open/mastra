# Settlement Reconciliation — As-Built Implementation

**Status:** Live (YES Bank UPI pilot)
**Last updated:** May 2026
**Companion doc:** [RECONCILIATION_AUTOMATION_PROPOSAL.md](./RECONCILIATION_AUTOMATION_PROPOSAL.md) (planning doc) · [RECONCILIATION.md](./RECONCILIATION.md) (general subsystem)

This doc describes what was actually built versus what was planned. The proposal is the *intent*; this doc is the *truth*. Read both when onboarding.

---

## 1. Headline differences from the proposal

| # | Plan | Actual | Reason |
|---|---|---|---|
| 1 | One workflow with `llm:'off'` flag | **Two workflows**: `settlement-recon` (deterministic, 4 steps) + `reconcile-workflow` (LLM, 8 steps) | Cleaner code paths; OpenArc routes via `config.workflow` exposed at `/integration/info` |
| 2 | 5 disposition scenarios | **11 disposition buckets** | Real finance pivot exposed more states (auto-refund split, awaiting-bank-credit gate) |
| 3 | 10-file report pack (00–09) | **3 CSV files** | Finance feedback + OOM on 145k rows. 3 files match their Excel pivot |
| 4 | CSV + XLSX (07 was XLSX) | **CSV only** | Streaming generator simpler; Excel opens CSV fine |
| 5 | Indefinite raw-file retention | **Staged rows purged post-run** (env-gated) | "We are not saving PII" |

Everything else from the proposal made it through largely intact — composite keys, anti-join, transforms, deterministic-first principle, LLM governance, audit trail per decision.

---

## 2. End-to-end flow (one diagram)

```
                       ┌─────────────────────────────────────────────┐
                       │  Finance ops uploads 4 files                │
                       │  (YES MIS, YES Incoming, Consolidated,      │
                       │   Bank statement) via OpenArc                │
                       └──────────────┬──────────────────────────────┘
                                      ▼
                    ┌────────────────────────────────────┐
                    │  POST /reco/upload (per file)      │
                    │  • adapter.parseFile(buffer)        │
                    │  • UPSERT reco_staged_transactions  │
                    │    keyed (configId, adapterId,      │
                    │           date, sourceId)           │
                    │  • mark prior runs 'superseded'     │
                    └──────────────┬─────────────────────┘
                                   │
                                   │   GET /reco/staged → "3/4 ready"
                                   │
                                   ▼ (operator clicks Run)
                   ┌────────────────────────────────────────────┐
                   │  POST /api/workflows/                       │
                   │       settlement-recon/start-async          │
                   │  (resolved from config.workflow field)      │
                   └──────────────┬─────────────────────────────┘
                                  ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  STEP 1 · openRunStep                                       │
        │  Idempotent insert into reco_runs                           │
        │  unique (date, configId). Reuses 'open' row if present.     │
        └──────────────┬──────────────────────────────────────────────┘
                       ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  STEP 2 · fetchAllSourcesStep                               │
        │  For each config.sources[i]:                                │
        │    • read from staging FIRST                                │
        │    • fall back to adapter.fetch() if staging empty AND      │
        │      adapter supports live fetch (e.g. internal-pg-db)      │
        │    • emits MANIFEST only ({adapterId, txnCount, origin})   │
        │      — NOT rows. Avoids 315MB workflow-snapshot OOM.        │
        └──────────────┬──────────────────────────────────────────────┘
                       ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  STEP 3 · deterministicMatchStep (THE HEART OF IT)          │
        │  Re-reads staged rows from DB; runs config.legs in order.   │
        │  When config.llm === 'off':                                 │
        │    a) runLegs() — 4-leg cascade                             │
        │    b) selectAutoRefundCandidateRrns()                       │
        │    c) yesAutoRefundsAdapter.fetch({candidates: RRNs})       │
        │       — live query against open_prod                        │
        │    d) applyDispositionRules() — first-match-wins            │
        │    e) Persist per-MIS summaries to reco_decisions inline    │
        │    f) Return { decisionsPersisted: true, totals: {...} }    │
        │    Downstream steps short-circuit.                          │
        └──────────────┬──────────────────────────────────────────────┘
                       ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  STEP 4 · settlementFinalizeStep                            │
        │  Asserts decisionsPersisted=true; marks run 'completed';    │
        │  passes precomputed totals through.                         │
        └──────────────┬──────────────────────────────────────────────┘
                       ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  STEP 5 · buildReportPackStep                               │
        │  Generator iterReportPackFiles() yields one file at a time. │
        │  Writes to $RECO_REPORT_PACK_ROOT/$runId/:                  │
        │    summary.csv                                              │
        │    settlement_report.csv                                    │
        │    exception_report.csv                                     │
        │  Then dbPurgeStagedForRun() unless RECO_PURGE_STAGING=false │
        └─────────────────────────────────────────────────────────────┘
```

The LLM-assisted `reconcile-workflow` shares steps 1, 2, 5 and inserts four additional steps between 3 and 5 — see §6.

---

## 3. The two workflows side-by-side

| Step | `settlement-recon` (llm:'off') | `reconcile-workflow` (llm:'on') |
|---|---|---|
| 1 | openRunStep | openRunStep |
| 2 | fetchAllSourcesStep | fetchAllSourcesStep |
| 3 | deterministicMatchStep *(persists inline, runs disposition)* | deterministicMatchStep *(emits arrays for fuzzy)* |
| 4 | settlementFinalizeStep | fuzzyMatchStep *(gpt-4o-mini × 8 parallel)* |
| 5 | buildReportPackStep | dispositionStep *(LLM per fuzzy result)* |
| 6 | — | reviewGateStep *(suspend/resume for `pending_review`)* |
| 7 | — | writeDecisionsStep |
| 8 | — | buildReportPackStep |

The branching point is line 343 of `workflow.ts`: `if (config.llm === 'off')`. The settlement path returns `decisionsPersisted: true` and the LLM-path steps (4–7) all check this flag at entry and no-op when true. Same code, two execution shapes.

---

## 4. The 4-leg cascade (YES Bank UPI)

Configured in `configs.ts:335–414` for `settlement-yes-pg`. Executed by `runLegs()` in `legs.ts`.

```
LEG 1 · MIS ↔ PG Incoming
   from: pg-yes-mis      to: pg-yes-incoming
   strategy: exact
   joinKey:  composite [utr, amountPaise, payerVpa]
   transformsByField: { utr: [digits_only, strip_whitespace],
                        payerVpa: [lowercase, strip_whitespace] }
   outputs: carryForward 'matched' → asSource 'leg1_matched'

   WHY: composite key prevents NPCI RRN collisions (same UTR can map
   to two transactions). Per-field transform is critical — applying
   digits_only to payerVpa would destroy name@bank VPAs. That bug
   surfaced 863 false negatives in pilot; fixed by transformsByField.

LEG 2 · leg1_matched ↔ Internal Postgres DB
   from: leg1_matched    to: internal-pg-db
   strategy: exact
   joinKey:  utr
   outputs: carryForward 'all' → asSource 'leg2_matched'

   Stub today (adapter returns empty). Will tighten to 'matched' once
   the internal DB is wired and we want a py_id cross-check.

LEG 3 · leg2_matched ANTI-JOIN Consolidated
   from: leg2_matched    to: pg-yes-consolidated
   strategy: exclude_if_present
   joinKey:  composite [utr, amountPaise]
   outputs: carryForward 'unmatched' → asSource 'leg3_carried'

   WHY: rows present in Consolidated are instant-settled already —
   drop them so we don't re-settle. Matched rows are tagged
   matchType='excluded'; only the unmatched residual carries forward.

LEG 4 · leg3_carried ↔ Bank statement
   from: leg3_carried    to: bank
   strategy: exact
   joinKey:  utr

   The cash-truth leg. Bank credit confirms funds are actually there.
   Whether or not a leg-4 match exists drives the awaiting_bank_credit
   gate in the disposition step.
```

Each `MatchStrategy` carries `ruleId` and is logged in the decision's `metadata.legId`. An auditor can trace back from any decision to the exact leg + strategy that fired.

---

## 5. Disposition: the 11 buckets

The deterministic rule engine in `disposition/engine.ts` walks the rule list top-to-bottom; first `when(ctx) === true` wins. Each rule emits a `DispositionMetadata { bucket, ruleId, ruleSource, reasonText, statuses }` attached to the MIS-anchored decision.

The YES rule set lives in `disposition/settlement-yes-pg.ts:95–217` and registers itself via `registerYesSettlementDisposition()` (called from `ensureConfigsRegistered()` — not a side-effect import; tree-shaking proofs).

| # | Bucket | Label (in `summary.csv`) | Rule predicate |
|---|---|---|---|
| 1 | `settled_instant` | Settled to merchant (Instant) | `ctx.inConsolidated` |
| 2 | `refund_late_authorized` | Late Authorised (Need to initiate refund) | `misSuccess && pgStatus ∈ {late_authorized…} && bankRow` |
| 3 | `refund_timeout` | TIMEOUT (Need to initiate refund) | `misStatus=Timeout && pgStatus ∈ {failed,timeout} && bankRow` |
| 4a | `auto_refund_failed` | Auto Refund FAILED | `hasAutoRefund && refundCode==='F'` |
| 4b | `auto_refund_pending` | Auto Refund Pending | `hasAutoRefund && refundCode===''` |
| 4c | `auto_refund_success` | Auto Refunded (Success) | `hasAutoRefund && refundCode==='S'` |
| 5 | `settled_next_day` | Settled to merchant (Next day Settlement) | `misSuccess && !inConsolidated && pgSettleable && bankRow !== null` |
| 5b | `awaiting_bank_credit` | Awaiting Bank Credit | `misSuccess && !inConsolidated && pgSettleable && bankRow === null` |
| 6 | `ignore_failed` | Failed (No funds — no action) | `failedInMis && failedInPg && bankRow === null` |
| 7 | `not_settled_checking` | Not Settled (Checking Internally) | `() => true` (catch-all) |
| 8 | `no_disposition` | Uncategorised (review) | Safety net — no rule fired |

**Critical detail — the bank-credit gate (5 vs 5b):** the same upstream pattern (MIS success + PG captured + not consolidated) splits on the presence of a bank-statement match. With credit → `settled_next_day`. Without credit → `awaiting_bank_credit` (do NOT settle; appears in the exception report; finance follows up with the partner). This was a finance-team escalation during build; not in the original 5 scenarios.

**Auto-refund detection** (rules 4a-c) is **live**, not heuristic:

- After leg 3, `selectAutoRefundCandidateRrns()` finds MIS rows that succeeded but have no PG row and aren't in Consolidated.
- Those RRNs feed `yesAutoRefundsAdapter.fetch({ candidates })` which opens a `pg.Client` to `RECO_OPEN_PROD_URL` and runs a parameterised SELECT on `icp_gateway_yesbank_upi_refunds JOIN pg_transactions ON bank_rrn IN ($1..$n)` — batches of 1000.
- The returned `pg_refund_status_code` (`S`/`F`/`''`) drives the three buckets.
- Fails soft (returns `[]`) if `RECO_OPEN_PROD_URL` is unset or the DB is unreachable. Candidates without a refund row fall through to `not_settled_checking`.
- The DSN must use a **read-only Postgres role** — code only ever issues SELECTs but there's no role enforcement in the runtime.

---

## 6. LLM-assisted workflow (for completeness)

The `reconcile-workflow` is unchanged from earlier docs but worth a one-paragraph recap so a reader doesn't have to chase another doc:

After deterministic matching, the residual unmatched rows are paired with their candidate pools and sent to `fuzzyMatchAgent` (gpt-4o-mini, 8 parallel) which picks a best candidate per row with a similarity score. Each fuzzy result + original txn goes to `dispositionAgent` which classifies into `auto_match` / `human_review` / `write_off` / `flag_fraud`. A confidence-graded short-circuit at `dispositionStep` line 727 skips the LLM call when `similarityScore >= 0.95` and the case is unambiguous, saving 20–60% of calls per run. Cases marked `human_review` cause the workflow to `suspend()` with a `ReviewSuspendSchema` payload; OpenArc's reco UI surfaces the queue; on operator decision it resumes with `ReviewResumePayload` and writes the final decisions. This path is used for non-settlement configs (Razorpay, Cashfree, Swiggy, etc.) — never for settlement-yes-pg.

---

## 7. The three output files

All in `$RECO_REPORT_PACK_ROOT/$runId/`. Built by `iterReportPackFiles()` as a generator (one file at a time, never the whole pack in memory).

### 7.1 `summary.csv`

Headline pivot mirroring the spreadsheet finance circulates today.

```
category,count,amount
Settled to merchant (Instant),12,45000.00
Settled to merchant (Next day Settlement),848,2950000.00
Awaiting Bank Credit,3,12500.00
Late Authorised (Need to initiate refund),5,18000.00
TIMEOUT (Need to initiate refund),2,7500.00
Auto Refunded (Success),6,21000.00
Auto Refund FAILED,1,3500.00
Failed (No funds — no action),21,0.00
Not Settled (Checking Internally),4,16000.00
Funds Received (Total),902,3073500.00
```

Empty buckets are omitted. Order follows `SETTLEMENT_BUCKET_ORDER` from `types.ts`.

### 7.2 `settlement_report.csv`

The to-be-settled (T+2) rows, **mirroring the original MIS file's columns exactly** so finance can upload it directly. Only rows in bucket `settled_next_day`. If the MIS raw is unavailable for any reason, falls back to minimal `sourceTxnId` only.

### 7.3 `exception_report.csv`

Every MIS row that did NOT settle, sorted by priority. Columns:

```
bucket | action | misRef | orderRef | amount | date | misStatus |
npciResponseCode | pgIncomingStatus | alreadySettled | bankCreditReceived |
refundStatus | refundReason | pyId | payerVpa | reason
```

`action` is a plain-English next step generated by `actionForBucket()` — e.g.:
- `auto_refund_failed` → "Auto-refund FAILED — money not returned; investigate & re-initiate refund"
- `awaiting_bank_credit` → "Hold — bank credit not received; settle once credited, else follow up with partner"

Sort order (highest priority first): `auto_refund_failed` → `refund_late_authorized` → `refund_timeout` → `awaiting_bank_credit` → `auto_refund_pending` → `not_settled_checking` → `no_disposition` → `ignore_failed`.

**Invariant:** `settlement.rows + exception.rows == total MIS rows`. Every MIS row lands in exactly one of the two reports. The summary is a pivot over both.

---

## 8. PII and data lifecycle

- **Raw uploaded files** are never persisted. The upload route parses on the fly into `NormalizedTxn[]` and only the normalised rows hit the staging table.
- **Staged rows** are deleted after the report pack is written, via `dbPurgeStagedForRun()`. Set `RECO_PURGE_STAGING=false` only in dev when re-running against the same data.
- **`reco_decisions`** holds the audit trail forever — but it contains decision metadata (bucket, ruleId, statuses, amount delta), not the full raw payload. A finance auditor asking "why did this settle?" gets back: ruleId, the status snapshot at decision time, and the legId — enough to defend the decision without exposing PII to the audit reader.
- **Report files** in `$RECO_REPORT_PACK_ROOT/$runId/` contain PII (VPAs, RRNs, account refs) and are served via a token-gated route. Production deployments should put this directory outside any static-served web root and rotate it on a retention schedule (TBD by compliance).

---

## 9. Configuration shape

The `settlement-yes-pg` config (`configs.ts:303–415`) is the template for future PG settlements. Every field on it:

```ts
{
  id: 'settlement-yes-pg',
  name: 'YES Bank UPI Settlement',
  description: '...',
  llm: 'off',                          // gates the workflow router
  workflow: 'settlement-recon',        // OpenArc reads this from /integration/info
  expected_resolution_days: 2,         // SLA hint, data-model only
  sources: [
    { adapterId: 'pg-yes-mis' },
    { adapterId: 'pg-yes-incoming' },
    { adapterId: 'pg-yes-consolidated' },
    { adapterId: 'bank', accountId: 'yes-current' },
    { adapterId: 'internal-pg-db', options: { pgName: 'yes' }, optional: true },
    // yes-auto-refunds is NOT here — it's queried dynamically by leg-1's
    // residual, not fetched at workflow start.
  ],
  legs: [/* see §4 */],
}
```

To add a second PG settlement (NPST, Paynext, etc.):

1. Build adapters for its MIS, Incoming, Consolidated, and bank-statement variants.
2. Add a disposition rule set in `disposition/settlement-<pg>.ts` covering the partner's status enum (the YES set's helpers — `misSuccess`, `pgSettleable`, etc. — are tightly coupled to YES; copy and adapt).
3. Register both with `ensureConfigsRegistered()` and `registerXxxSettlementDisposition()`.
4. Add a config with `llm: 'off'`, `workflow: 'settlement-recon'`, and per-partner legs.
5. The same workflow runs unchanged.

---

## 10. Operational endpoints

| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /reco/upload` | Multipart upload, parses + stages one file | bearer (MASTRA_INTEGRATION_TOKEN) |
| `GET /reco/staged?configId&date` | Which sources are ready for this run | bearer |
| `POST /reco/fetch` | Live-fetch a source via adapter (skips upload) | bearer |
| `DELETE /reco/staged?…` | Wipe one staged slot | bearer |
| `POST /api/workflows/settlement-recon/start-async` | Trigger the run | (workflow-router default) |
| `GET /integration/reco/runs/:runId/decisions` | Read decisions (capped at 500 for UI) | bearer |
| `GET /integration/reco/runs/:runId/report-pack` | List files in the run's pack | bearer |
| `GET /integration/reco/runs/:runId/report-pack/file?path=` | Stream one pack file | bearer |

The OpenArc backend proxies all of these. Frontend never talks to Mastra directly.

---

## 11. What's NOT built (and where to look when you build it)

| Item | Status | Pointer |
|---|---|---|
| Per-leg drill-down CSVs (matched/unmatched per leg) | Out of scope — finance doesn't want them | Disposition-engine has `legId` on every decision; can be reconstructed from the decisions table if ever needed |
| XLSX exception report | Dropped — CSV is sufficient | `reports/csv.ts` would need a `reports/xlsx.ts` peer |
| Automated file intake (SMTP, portal scraping) | Phase 6+ per proposal | n/a |
| NPST / other PGs | Phase 4+ per proposal | The 5-step "add a new PG" recipe above |
| Internal py_id cross-check (Leg 2) | Stub — adapter returns [] | `adapters/internal-pg-db.ts`; wire DSN, query, normalisation |
| AI-authored rules (`source: 'ai', status: 'proposed'`) | Data-model only | Add UI to activate proposed rules; rule loader already honours the source field |
| Per-record SLA derivation | Field exists (`expected_resolution_days`), not derived | Add a scheduled scorer that flags overdue cases |
| Webhook events | Designed, not built | Proposal §C "Deferred to v2" |
| Property Definitions / JSON filter DSL | Designed, not built | Same |
| Pattern-detection alerts | Phase 5+ | n/a |

---

## 12. Key files map

| File | What it does |
|---|---|
| `workflow.ts` | Both workflows + all 8 step definitions |
| `legs.ts` | `runLegs()` — multi-leg cascade with carry-forward |
| `matcher.ts` | 5 match strategies + composite-key + transforms |
| `adapter.ts` | Type contracts: `SourceAdapter`, `ReconcileConfig`, `MatchStrategy`, `ReconcileLeg` |
| `configs.ts` | All 8 reco configs + adapter registration |
| `disposition/engine.ts` | `evaluateRules`, `buildMisContexts`, `applyDispositionRules`, `selectAutoRefundCandidateRrns` |
| `disposition/settlement-yes-pg.ts` | The 11 buckets' rule predicates + reason text + registration |
| `types.ts` | `NormalizedTxn`, `SettlementBucket`, `DispositionMetadata`, schemas |
| `adapters/pg-yes-mis.ts` | Parses YES 41-col MIS workbook |
| `adapters/pg-yes-incoming.ts` | Parses our 20-col internal Incoming report |
| `adapters/pg-yes-consolidated.ts` | Parses 30-col already-settled list |
| `adapters/bank-statement.ts` | Parses bank statement (3 amount-column shapes detected) |
| `adapters/yes-auto-refunds.ts` | RRN-batched live SELECT against open_prod |
| `reports/report-pack-builder.ts` | `iterReportPackFiles()` generator + the 3 builders |
| `reports/csv.ts` | RFC 4180-safe CSV writer |
| `db.ts` | Staging table + decisions table + run lifecycle + index hints |
| `routes/reco-upload.ts` | Upload + staged-list + live-fetch + delete-slot routes |
| `routes/integration.ts` | OpenArc-facing read endpoints + workflow router lookup |

---

## 13. Acceptance against the proposal's success metrics

| Metric (from proposal §8.1) | Target | Status |
|---|---|---|
| Auto-match rate | ≥ 80% | Pending side-by-side validation |
| Zero false-settle | Required | Architecture guarantees: deterministic rules + bank-credit gate (5b) blocks settlement when funds not in bank |
| Zero missed refunds | Required | Rules 2, 3, 4a explicitly cover late-auth, timeout, auto-refund-failed |
| Daily reco time ≤ 20 min | Required | Pending finance team validation |
| Finance signs off on dashboard | Required | Decisions-table removed for settlement; summary pivot card surfaces results inline |

The deterministic-first design means the first three are guarantees by construction. Time savings and ergonomics will be validated by the finance team during the 5-day cutover.

---

*Read this with the proposal open in another window for the "why we built this" picture. Read it with the code open for the "how it actually works" picture.*
