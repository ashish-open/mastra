/**
 * Disposition rules for the YES Bank UPI Settlement workflow.
 *
 * Encodes the FIVE scenarios from the YES Bank Settlement SOP as pure-rule
 * TypeScript. Each rule is a typed function — finance team reads this file
 * to verify the logic; engineering owns the structure; both review changes
 * via PR. No LLM. Same input → same output.
 *
 * SOP source: the recon person's own daily process (captured 2026-05-27) — the
 * categories here mirror their Excel summary pivot 1:1. The detailed rule order
 * and rationale live on the YES_SETTLEMENT_RULES array below.
 */

import {
  registerDispositionRules,
  rawField,
  statusMatches,
  type DispositionRule,
} from './engine.js';

/**
 * Helper: read the MIS Transaction Status (Successful / Failed / Late Authorized / Timeout).
 * MIS adapter stashed it in raw._transactionStatus per the parser contract.
 */
const misStatus = (ctx: { misRow: import('./engine.js').DispositionContext['misRow'] }) =>
  rawField(ctx.misRow, '_transactionStatus');

/**
 * Helper: read the NPCI response code from MIS. "00" = success per NPCI.
 * MIS adapter stashed it in raw._npciResponseCode.
 */
const npciCode = (ctx: { misRow: import('./engine.js').DispositionContext['misRow'] }) =>
  rawField(ctx.misRow, '_npciResponseCode');

/**
 * Helper: read the PG Incoming transaction status (our internal record).
 * Values seen in production: 'success', 'failed', 'late_authorized', 'timeout'.
 */
const pgStatus = (ctx: { pgIncomingRow: import('./engine.js').DispositionContext['pgIncomingRow'] }) =>
  rawField(ctx.pgIncomingRow, '_pgTransactionStatus');

/** True when MIS shows the txn Successful (status text or NPCI "00"). */
const misSuccess = (ctx: import('./engine.js').DispositionContext) =>
  statusMatches(misStatus(ctx), ['Successful', 'SUCCESS']) || npciCode(ctx) === '00';

/**
 * PG row is settle-eligible: matched in PG and NOT in a failure/refund state.
 *
 * The PG "incoming" status for a good payment is `captured` (also seen:
 * success/successful, or blank when matched-but-status-absent). We accept all of
 * those and only EXCLUDE the states that mean "don't settle": failed (no funds)
 * and late_authorized / timeout (handled by the refund rules above, which run
 * first when a bank credit exists). This is an exclusion list so we don't have
 * to enumerate every positive PG status value the platform might emit.
 */
const PG_NON_SETTLE_STATUSES = [
  'failed', 'Failed', 'FAILED',
  'late_authorized', 'Late Authorized', 'LATE_AUTHORIZED', 'late authorised', 'Late Authorised',
  'timeout', 'Timeout', 'TIMEOUT',
];
const pgSettleable = (ctx: import('./engine.js').DispositionContext) =>
  ctx.pgIncomingRow !== null && !statusMatches(pgStatus(ctx), PG_NON_SETTLE_STATUSES);

/**
 * Auto-refund status code from the open_prod refunds source (yes-auto-refunds),
 * matched by RRN. 'S' = succeeded, 'F' = failed, '' = pending. Empty string when
 * there is NO refund record (the row was not auto-refunded).
 */
const refundCode = (ctx: import('./engine.js').DispositionContext): 'S' | 'F' | '' | null =>
  ctx.refundRow ? ((rawField(ctx.refundRow, '_refundStatusCode').trim() || '') as 'S' | 'F' | '') : null;
/** A row qualifies for the auto-refund family: Success in MIS, no PG record, and a refund record exists. */
const hasAutoRefund = (ctx: import('./engine.js').DispositionContext) =>
  misSuccess(ctx) && ctx.pgIncomingRow === null && !ctx.inConsolidated && ctx.refundRow !== null;

/**
 * YES Bank settlement categories — rebuilt 2026-05-27 from the recon person's
 * own SOP (see the conversation captured in RECONCILIATION docs). Categories
 * mirror their daily Excel pivot exactly. First-match-wins, top→down.
 *
 *   1. settled_instant          Present in Consolidated (instant-settled, ~15-min cadence).
 *                               We cross-check MIS against the Consolidated list and
 *                               REMOVE these from the to-be-settled (T+2) set.
 *   2. refund_late_authorized   MIS Success, PG Late Authorized, bank credit received → refund.
 *   3. refund_timeout           MIS Timeout, PG Failed/Timeout, bank credit received → refund.
 *   4. auto_refunded            MIS Success but missing in BOTH internal records (no PG row,
 *                               not in Consolidated). Finance verifies via a Metabase query
 *                               (to be wired). Surfaced as its own category meanwhile.
 *   5. settled_next_day         MIS Success, matched in PG, NOT instant-settled → settle T+2.
 *   6. ignore_failed            Failed in both, no bank credit → no action.
 *   7. not_settled_checking     Anything else — checking internally.
 *
 * NOTE on ordering: settled_instant MUST come first so an already-settled row
 * is never re-classified as a refund or re-settled.
 */
export const YES_SETTLEMENT_RULES: DispositionRule[] = [
  // ─── 1. Settled (Instant) ──────────────────────────────────────────────────
  {
    id: 'yes_settled_instant',
    bucket: 'settled_instant',
    when: ctx => ctx.inConsolidated,
    reasonText:
      'Present in the Consolidated settlement file — already instant-settled to the merchant ' +
      '(~15-min cadence). Removed from the to-be-settled (T+2) set.',
  },

  // ─── 2. Late Authorised → refund ─────────────────────────────────────────
  {
    id: 'yes_refund_late_authorized',
    bucket: 'refund_late_authorized',
    when: ctx =>
      misSuccess(ctx)
      && statusMatches(pgStatus(ctx), ['late_authorized', 'Late Authorized', 'LATE_AUTHORIZED', 'late authorised', 'Late Authorised'])
      && ctx.bankRow !== null,
    reasonText:
      'Successful in MIS but Late Authorised in our internal record (user got a failure response). ' +
      'Bank credit received → initiate refund to source account.',
  },

  // ─── 3. TIMEOUT → refund ───────────────────────────────────────────────────
  {
    id: 'yes_refund_timeout',
    bucket: 'refund_timeout',
    when: ctx =>
      statusMatches(misStatus(ctx), ['Timeout', 'TIMEOUT'])
      && statusMatches(pgStatus(ctx), ['failed', 'Failed', 'FAILED', 'timeout', 'Timeout', 'TIMEOUT'])
      && ctx.bankRow !== null,
    reasonText:
      'Timeout in MIS, Failed/Timeout in our internal record, but bank credit was received ' +
      '→ initiate refund to source account.',
  },

  // ─── 4. Auto-refund family (Success in MIS, no PG row, refund record exists) ─
  // The open_prod refunds source (yes-auto-refunds) is the source of truth. We
  // classify by pg_refund_status_code. A MIS-success row with NO refund record
  // does NOT match here — it falls through to the catch-all (Not Settled /
  // Checking Internally), per the finance decision.
  //
  // 4a. Auto Refund FAILED — money was NOT returned to the customer. Exception.
  {
    id: 'yes_auto_refund_failed',
    bucket: 'auto_refund_failed',
    when: ctx => hasAutoRefund(ctx) && refundCode(ctx) === 'F',
    reasonText:
      'Successful in MIS, no internal PG record, and the auto-refund FAILED (pg_refund_status_code=F). ' +
      'Customer money was NOT returned — investigate and re-initiate the refund.',
  },
  // 4b. Auto Refund Pending — refund initiated but status not yet confirmed.
  {
    id: 'yes_auto_refund_pending',
    bucket: 'auto_refund_pending',
    when: ctx => hasAutoRefund(ctx) && (refundCode(ctx) === '' ),
    reasonText:
      'Successful in MIS, no internal PG record, auto-refund record present but status is blank/pending. ' +
      'Refund not yet confirmed — monitor until it settles to S (success) or F (failed).',
  },
  // 4c. Auto Refunded (Success) — refund completed. No action.
  {
    id: 'yes_auto_refund_success',
    bucket: 'auto_refund_success',
    when: ctx => hasAutoRefund(ctx) && refundCode(ctx) === 'S',
    reasonText:
      'Successful in MIS, no internal PG record, auto-refund completed (pg_refund_status_code=S). ' +
      'Money returned to the customer — no action required.',
  },

  // ─── 5. Settled (Next day / T+2) ───────────────────────────────────────────
  {
    id: 'yes_settled_next_day',
    bucket: 'settled_next_day',
    // Bank credit MUST be present — we only settle money we have actually
    // received in the bank account.
    when: ctx => misSuccess(ctx) && !ctx.inConsolidated && pgSettleable(ctx) && ctx.bankRow !== null,
    reasonText:
      'Successful and captured in our PG Incoming record, bank credit received, not instant-settled ' +
      '→ to be settled to the merchant on the next-day (T+2) cycle.',
  },

  // ─── 5b. Awaiting Bank Credit ──────────────────────────────────────────────
  // Same as next-day settle EXCEPT the bank credit has not arrived yet. We must
  // NOT settle until funds are in the bank account. Hold for the next-day credit;
  // if still missing, finance follows up with the partner.
  {
    id: 'yes_awaiting_bank_credit',
    bucket: 'awaiting_bank_credit',
    when: ctx => misSuccess(ctx) && !ctx.inConsolidated && pgSettleable(ctx) && ctx.bankRow === null,
    reasonText:
      'Successful and captured in our PG Incoming record but NO matching credit found in the bank ' +
      'statement yet — do NOT settle. Hold for the next-day bank credit; if still missing, follow up with the partner.',
  },

  // ─── 6. Failed (no funds, no action) ───────────────────────────────────────
  {
    id: 'yes_ignore_failed',
    bucket: 'ignore_failed',
    when: ctx => {
      const failedInMis = statusMatches(misStatus(ctx), ['Failed', 'FAILED'])
        || (npciCode(ctx) !== '' && npciCode(ctx) !== '00');
      const failedInPg = ctx.pgIncomingRow === null
        || statusMatches(pgStatus(ctx), ['failed', 'Failed', 'FAILED']);
      return failedInMis && failedInPg && ctx.bankRow === null;
    },
    reasonText: 'Failed in both MIS and our internal record, no bank credit received — no action required.',
  },

  // ─── 7. Not Settled (Checking Internally) — catch-all ──────────────────────
  {
    id: 'yes_not_settled_checking',
    bucket: 'not_settled_checking',
    when: () => true,
    reasonText: ctx => {
      const m = misStatus(ctx) || '(blank)';
      const p = ctx.pgIncomingRow ? (pgStatus(ctx) || 'matched/blank') : 'not found in PG';
      const b = ctx.bankRow ? 'received' : 'missing';
      return `Does not match a known settlement scenario (MIS=${m}, PG=${p}, bank credit=${b}) — checking internally.`;
    },
  },
];

/**
 * Register the YES settlement disposition rule set.
 *
 * Called explicitly from `ensureConfigsRegistered()` in configs.ts — NOT a
 * module-load side effect. The built `.mastra/output` bundle tree-shakes
 * side-effect-only imports, which silently dropped this registration and left
 * the dispositions/settlement/exception reports empty. Explicit call = no
 * tree-shaking surprise (same fix we applied to adapter registration).
 */
export function registerYesSettlementDisposition(): void {
  registerDispositionRules('settlement-yes-pg', YES_SETTLEMENT_RULES, {
    // The MIS file is the authoritative "transaction happened" source — one
    // summary decision per MIS row records the final bucket.
    anchorAdapterId: 'pg-yes-mis',
    pgIncomingAdapterId: 'pg-yes-incoming',
    bankAdapterId: 'bank',
    matchLegId: 'leg-1-mis-vs-incoming',
    antiJoinLegId: 'leg-3-antijoin-consolidated',
    bankLegId: 'leg-4-bank-settlement',
    refundsAdapterId: 'yes-auto-refunds',
    // A row is worth looking up in the auto-refund DB only when it's Success in
    // MIS, has NO internal PG record, and is not instant-settled — i.e. the
    // "success but missing everywhere" set. The workflow sends just these RRNs
    // to open_prod (lookup-by-RRN), never the whole MIS.
    autoRefundCandidate: (ctx) => misSuccess(ctx) && ctx.pgIncomingRow === null && !ctx.inConsolidated,
    // Status snapshot for the exception report — shows finance, per unreconciled
    // MIS row, the status on each side, whether cash arrived, and the auto-refund
    // status when a refund record exists.
    statusSnapshot: (ctx) => ({
      misStatus: misStatus(ctx) || '(blank)',
      npciResponseCode: npciCode(ctx) || '(blank)',
      pgIncomingStatus: ctx.pgIncomingRow ? (pgStatus(ctx) || 'present') : 'not_found_in_pg',
      alreadySettled: ctx.inConsolidated,
      bankCreditReceived: ctx.bankRow !== null,
      refundStatusCode: ctx.refundRow ? (rawField(ctx.refundRow, '_refundStatusCode') || 'pending') : '',
      refundReason: ctx.refundRow ? rawField(ctx.refundRow, 'refund_reason') : '',
    }),
  });
}
