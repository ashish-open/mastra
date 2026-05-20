# Per-config rule sheets

This directory holds markdown files that customize how the **disposition
agent** behaves for a specific `ReconcileConfig`.

## How it works

1. The reco workflow runs against a given `configId` (e.g. `bank-pg-razorpay`).
2. The disposition step reads `rules/<configId>.md` via the loader at
   `loader.ts`.
3. Whatever's in the file is appended to the LLM prompt under
   `## Config-specific rules`.
4. The agent's universal decision matrix still runs first (fraud check,
   auto-match threshold, etc.); these rules layer on top to fine-tune
   judgment calls for that platform's known quirks.

Missing file → empty string → no overrides. Most configs won't need a sheet
on day one; add when you notice repeated false flags or missed write-offs.

## When to write a rule

| Signal | Action |
|---|---|
| Multiple `flag_fraud` decisions on legitimate platform settlements | Add a rule explaining the platform's expected fee/UTR shape |
| Refunds (negative txns) consistently mis-disposed | Document the refund pattern and what to do |
| Specific aging cutoff differs from the global default (30 days) | Note the platform's settlement window |

## How to write a rule

Plain markdown — the LLM reads it like an analyst would. Be concrete:

- ✅ `Razorpay PG settles T+2. daysOld ≤ 4 is in-window — don't flag as fraud just because no bank credit appears yet.`
- ❌ `Be careful with Razorpay.` (too vague)

Examples:

- Document the platform's **fee model** so amount deltas don't get
  mis-interpreted as fraud signals.
- Document the **settlement cadence** so write_off doesn't fire too early.
- Call out **shape exceptions** (e.g. "refunds are common; default to
  human_review, not flag_fraud").
- Override **per-platform thresholds** ("for this platform, daysOld < 7
  means human_review even with no candidate").

## Don't

- Don't restate the universal matrix (auto_match / human_review / write_off
  / flag_fraud). The agent already has it.
- Don't ask the LLM to do arithmetic — pre-compute it in the workflow.
- Don't put PII (real merchant ids, customer names) — these files are in
  git. Use placeholders.

## After editing

The loader caches per-process. Restart the Mastra dev server (or wait for
the next reload cycle) to pick up changes.
