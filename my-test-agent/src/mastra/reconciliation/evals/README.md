# Reconciliation Evals

This folder is the "correctness measurement" layer for the reconciliation agents.

## Files

| File | Purpose |
|---|---|
| `dataset.ts` | ~20 hand-crafted labeled cases covering 10 edge-case categories |
| `scorers.ts` | 3 scorers: candidate-validity, disposition-accuracy, reasoning-quality |
| `run-eval.ts` | CLI runner — runs the agents over the dataset, prints scoreboard |

## Run

```bash
pnpm eval:reco
```

This runs both agents (`fuzzyMatchAgent`, `dispositionAgent`) against every case in `dataset.ts`, scores their outputs, and prints:

1. **Per-case** ✓/✗ markers with detail on misses
2. **Headline numbers** — 4 metrics
3. **Per-category breakdown** — where do we win / lose?

## The 4 headline metrics

| Metric | What it measures | What "good" looks like |
|---|---|---|
| **Candidate Validity** | Does fuzzy matcher pick a real ID from the pool (no hallucinations)? | 100% — anything less is a serious bug |
| **Best-Candidate Pick** | Does fuzzy matcher pick the *right* candidate from the pool? | >85% on most categories, but `ambiguous_dup` and `fraud_pattern` are intentionally hard |
| **Reasoning Quality** | LLM-judged: does the reasoning cite real signals (amount delta, counterparty match) vs generic phrases? | >0.7 average |
| **Disposition Accuracy** | Does disposition agent pick the same recommendation as the labeled expected? | >75% — judgment calls are fuzzy, expect some divergence |

## Adding new cases

When a customer ticket surfaces a new edge case:

1. Add a new entry to `FUZZY_CASES` or `DISPOSITION_CASES` in `dataset.ts`
2. Pick a `category` from `CATEGORIES` (or extend that list)
3. Re-run `pnpm eval:reco`

The dataset is hand-curated, not generated. Each case represents a real customer scenario that should produce a known correct answer.

## When to run

- **Before any prompt change** — capture baseline numbers
- **After any prompt change** — confirm the change didn't regress
- **After any model swap** — gpt-4o-mini vs gpt-4o etc.
- **Weekly in CI** — catch silent regressions when underlying models update

## Scoring philosophy

- **Code-only scorers** (candidate-validity, disposition-accuracy) are deterministic. Their scores never drift.
- **LLM-judged scorers** (reasoning-quality) have inherent noise; expect ±0.05 run-to-run. Use them for trends, not single-run comparisons.

## Tying scores to production decisions

When `Candidate Validity` drops below 100%, **block the deployment** — the agent is hallucinating IDs and matching wrong transactions. That's a real-money bug.

`Disposition Accuracy` is a soft target — humans disagree with each other on borderline cases (refund chains, ambiguous duplicates). Track the trend, but don't gate releases on it.
