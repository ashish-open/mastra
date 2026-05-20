# Rules for `restaurant-swiggy`

Reconciling restaurant POS orders against Swiggy aggregator settlements
and finally against the bank statement.

## Fee model — big deductions are NORMAL

Swiggy deducts roughly **26–28% of gross** before paying out:

- Commission: **22% of gross**
- GST on commission: **18% of commission** ≈ 3.96% of gross
- TCS: **1% of gross**

So `net ≈ gross × 0.72`. A delta of ~28% between the POS gross and the
Swiggy settlement net is **expected** — never flag as fraud or
amount-mismatch. The matcher's `amount_tolerance` strategy already
accounts for this via `swiggyExpectedNetPaise()`; this rule exists for
when the LLM sees the raw delta on a fuzzy case.

## Settlement cadence

- Swiggy settles **daily** for orders that are **T-2** old.
- A POS order with `daysOld ≤ 5` and no Swiggy settlement row yet is
  in-window — `human_review`, do not write off.
- A POS order with `daysOld > 10` and no Swiggy row is genuinely missing
  — `human_review` with a note to check the Swiggy partner dashboard.

## Refunds + cancellations

- Customer cancellations are very common in food delivery. They appear as
  negative entries (refund_chain category) on the Swiggy side without a
  matching POS row, OR as a POS row that was later voided.
- Default these to `human_review` — the restaurant manager needs to
  reconcile against the cancellation log manually.

## Deductions beyond commission

Swiggy occasionally deducts:
- **Customer compensation** (cold food, late delivery) — appears as a
  one-off debit on the Swiggy settlement.
- **Marketing co-funding** — when the restaurant opted into a Swiggy
  promotion, ~5% extra is deducted.

These extra deductions are platform-legitimate. If the delta is
suspicious (>10% over expected net) AND there's no marketing campaign
flag — that's a real `human_review` case. Otherwise it's normal noise.

## What this overrides

- Don't fire `flag_fraud` on Swiggy-shaped rows (counterparty contains
  `Swiggy`, description includes "SWIGGY SETTLEMENT", etc.) just because
  the amount is round — restaurant settlements often land on neat
  numbers.
- Write-off threshold for Swiggy: amount < ₹500 AND `daysOld > 14` (the
  global default ₹1,000 / 30-day is too aggressive for this platform's
  ticket size).
