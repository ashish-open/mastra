# Rules for `bank-pg-razorpay`

Reconciling Razorpay payment-gateway settlements against bank credits.

## Settlement cadence

- Razorpay batches multiple payments into a single bank credit. Settlement
  happens roughly **T+2** (sometimes T+3 over weekends / public holidays).
- A PG transaction with `daysOld ≤ 4` and no matching bank credit is
  **in-window** — recommend `human_review`, do NOT flag as fraud or write
  off. The bank credit may still be on its way.
- A PG transaction with `daysOld > 7` and no matching bank credit IS
  unusual — escalate to `human_review` with a note suggesting the operator
  check the Razorpay dashboard's "Pending settlements" view.

## Fee model

- Standard: `fee = 2% of gross`, `gst = 18% of fee`. So
  `net ≈ gross × (1 − 0.02 × 1.18) ≈ gross × 0.9764`.
- An amount delta of roughly 2.4% between a PG row's gross and the bank
  credit's net is **expected** — not a fraud signal.
- A delta > 5% with no batch grouping is unusual — `human_review`.

## UTR conventions

- Settlement UTRs look like `UTR_RZP<3+ digits>` in test data and
  `<10–22 alphanumeric chars>` in production. Both are valid shapes.
- A malformed UTR (`UTR_WRONG_*`, `XXX000000`, all zeros) on a PG row that
  otherwise has a plausible bank credit is the typo case — recommend
  `human_review` so the operator can correct it. Don't flag as fraud
  unless multiple signals stack.

## Refunds

- Refunds (`rzp_rfnd_*`, negative amount) are common. They show up on the
  PG side as negative entries within a settlement batch. The batch
  matcher should already net them into the batch sum.
- An ORPHAN refund (negative amount, no matching outflow on bank) within
  the window: `human_review` — likely a pending refund settlement.

## What this overrides

- The default 30-day write-off cutoff for Razorpay is too aggressive given
  T+2 settlement. Use 14 days here.
- The global "any unknown counterparty → fraud signal" check shouldn't
  fire on Razorpay-shaped rows (description contains `Razorpay`,
  counterparty is `Razorpay`, etc.) — those are platform settlements.
