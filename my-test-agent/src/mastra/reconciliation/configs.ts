/**
 * Reconciliation configs — adapter registry + declarative match graphs.
 *
 * Every config lists:
 *   - sources: which adapters feed into the run (each becomes one upload slot
 *     OR one real-API fetch)
 *   - matches: ordered match strategies the workflow walks
 *
 * To add a new reco type:
 *   1. Write a new SourceAdapter in adapters/
 *   2. registerAdapter(...) inside ensureConfigsRegistered()
 *   3. registerConfig({ sources, matches }) inside ensureConfigsRegistered()
 *   4. Pick the config id when triggering the workflow
 *
 * Current configs:
 *   bank-pg-internal       — Internal Ledger ↔ Zwitch PG ↔ Bank
 *   bank-pg-razorpay       — Razorpay PG ↔ Bank
 *   bank-pg-cashfree       — Cashfree PG ↔ Bank
 *   restaurant-swiggy      — POS ↔ Swiggy ↔ Bank
 *   restaurant-zomato      — POS ↔ Zomato ↔ Bank
 *   restaurant-zepto       — Seller Inventory ↔ Zepto ↔ Bank
 *   erp-bank-tally         — Tally ERP AR Invoices ↔ Bank
 *
 * The `accountId` on the bank source is a free-form label — used to scope
 * uploads in case a merchant reconciles against multiple bank accounts.
 */

import { registerAdapter, registerConfig } from './adapter.js';
import { internalLedgerAdapter } from './adapters/internal-ledger.js';
import { zwitchPGAdapter } from './adapters/pg-zwitch.js';
import { bankStatementAdapter } from './adapters/bank-statement.js';
import { swiggyAdapter, swiggyExpectedNetPaise } from './adapters/swiggy.js';
import { razorpayPGAdapter } from './adapters/pg-razorpay.js';
import { cashfreePGAdapter } from './adapters/pg-cashfree.js';
import { zomatoAdapter, zomatoExpectedNetPaise } from './adapters/zomato.js';
import { zeptoAdapter, zeptoExpectedNetPaise } from './adapters/zepto.js';
import { tallyERPAdapter, tallyExpectedNetPaise } from './adapters/erp-tally.js';
import { posAdapter, posZomatoAdapter, posZeptoAdapter } from './adapters/pos.js';
// Phase 1.6 + Phase 3 settlement-yes-pg adapters. Imported as named exports
// and explicitly registered inside `ensureConfigsRegistered()` below so the
// registration timing matches the legacy pattern (avoids side-effect-import
// tree-shaking surprises during dev / build).
import { internalPgDbAdapter } from './adapters/internal-pg-db.js';
import { pgYesMisAdapter } from './adapters/pg-yes-mis.js';
import { pgYesIncomingAdapter } from './adapters/pg-yes-incoming.js';
import { pgYesConsolidatedAdapter } from './adapters/pg-yes-consolidated.js';
import { yesAutoRefundsAdapter } from './adapters/yes-auto-refunds.js';
// YES Bank disposition rules. Registered explicitly inside
// ensureConfigsRegistered() (NOT a side-effect import) — the built bundle
// tree-shakes side-effect-only imports, which left the disposition/settlement/
// exception reports empty.
import { registerYesSettlementDisposition } from './disposition/settlement-yes-pg.js';

/** Sentinel exported so `import { RECO_CONFIGS_LOADED }` keeps the file alive. */
export const RECO_CONFIGS_LOADED = true as const;

let _registered = false;

export function ensureConfigsRegistered(): void {
  if (_registered) return;
  _registered = true;

  // ── Adapters ──────────────────────────────────────────────────────────────
  registerAdapter(internalLedgerAdapter);
  registerAdapter(zwitchPGAdapter);
  registerAdapter(bankStatementAdapter);
  registerAdapter(swiggyAdapter);
  registerAdapter(razorpayPGAdapter);
  registerAdapter(cashfreePGAdapter);
  registerAdapter(zomatoAdapter);
  registerAdapter(zeptoAdapter);
  registerAdapter(tallyERPAdapter);
  registerAdapter(posAdapter);
  registerAdapter(posZomatoAdapter);
  registerAdapter(posZeptoAdapter);
  // YES Bank pilot + DB cross-check adapters.
  registerAdapter(internalPgDbAdapter);
  registerAdapter(pgYesMisAdapter);
  registerAdapter(pgYesIncomingAdapter);
  registerAdapter(pgYesConsolidatedAdapter);
  registerAdapter(yesAutoRefundsAdapter);

  // ── Disposition rule sets (separate registry from adapters) ───────────────
  registerYesSettlementDisposition();

  // ── Config 1: Internal Ledger ↔ Zwitch PG ↔ Bank ─────────────────────────
  registerConfig({
    id: 'bank-pg-internal',
    name: 'Internal Ledger ↔ Zwitch PG ↔ Bank',
    description:
      "3-way reco: merchant's own ledger (DB or CSV) ↔ Zwitch PG settlements ↔ bank statement credits.",
    sources: [
      { adapterId: 'internal' },
      { adapterId: 'pg-zwitch' },
      { adapterId: 'bank', accountId: 'primary' },
    ],
    matches: [
      {
        name: 'internal_to_pg',
        from: 'internal',
        to: 'pg-zwitch',
        strategy: 'exact',
        joinKey: 'merchantRefId',
      },
      {
        name: 'pg_batch_to_bank',
        from: 'pg-zwitch',
        to: 'bank',
        strategy: 'sum_then_match',
        joinKey: 'utr',
        aggregateBy: 'settlementId',
      },
    ],
  });

  // ── Config 2: Razorpay PG ↔ Bank ──────────────────────────────────────────
  registerConfig({
    id: 'bank-pg-razorpay',
    name: 'Razorpay PG ↔ Bank',
    description:
      'Razorpay settlement batches (2% fee + 18% GST on fee) against bank credits. ' +
      'Real-API fetch enabled when RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set.',
    sources: [
      { adapterId: 'pg-razorpay' },
      { adapterId: 'bank', accountId: 'razorpay-settlement' },
    ],
    matches: [
      {
        name: 'razorpay_batch_to_bank',
        from: 'pg-razorpay',
        to: 'bank',
        strategy: 'sum_then_match',
        joinKey: 'utr',
        aggregateBy: 'settlementId',
        tolerancePaise: 0,
      },
    ],
  });

  // ── Config 3: Cashfree PG ↔ Bank ──────────────────────────────────────────
  registerConfig({
    id: 'bank-pg-cashfree',
    name: 'Cashfree PG ↔ Bank',
    description:
      'Cashfree settlement batches (1.75% fee + 18% GST on fee) against bank credits. ' +
      'Real-API fetch enabled when CASHFREE_APP_ID / CASHFREE_SECRET_KEY are set.',
    sources: [
      { adapterId: 'pg-cashfree' },
      { adapterId: 'bank', accountId: 'cashfree-settlement' },
    ],
    matches: [
      {
        name: 'cashfree_batch_to_bank',
        from: 'pg-cashfree',
        to: 'bank',
        strategy: 'sum_then_match',
        joinKey: 'utr',
        aggregateBy: 'settlementId',
        tolerancePaise: 0,
      },
    ],
  });

  // ── Config 4: Restaurant POS ↔ Swiggy ↔ Bank ─────────────────────────────
  registerConfig({
    id: 'restaurant-swiggy',
    name: 'Restaurant POS ↔ Swiggy ↔ Bank',
    description:
      "Reconciles a restaurant's POS orders against Swiggy settlements (22% commission + 18% GST + 1% TCS) and the bank credit. All three sources are upload-only.",
    sources: [
      { adapterId: 'pos' },
      { adapterId: 'swiggy' },
      { adapterId: 'bank', accountId: 'swiggy-settlement' },
    ],
    matches: [
      {
        name: 'pos_to_swiggy_with_commission',
        from: 'pos',
        to: 'swiggy',
        strategy: 'amount_tolerance',
        joinKey: 'merchantRefId',
        expectedNetPaise: gross => swiggyExpectedNetPaise(gross),
        tolerancePaise: 100,
      },
      {
        name: 'swiggy_batch_to_bank',
        from: 'swiggy',
        to: 'bank',
        strategy: 'sum_then_match',
        joinKey: 'utr',
        aggregateBy: 'settlementId',
        tolerancePaise: 0,
      },
    ],
  });

  // ── Config 5: Restaurant POS ↔ Zomato ↔ Bank ─────────────────────────────
  registerConfig({
    id: 'restaurant-zomato',
    name: 'Restaurant POS ↔ Zomato ↔ Bank',
    description:
      "Reconciles a restaurant's POS orders against Zomato settlements (25% commission + 18% GST + 1% TCS) and the bank credit.",
    sources: [
      { adapterId: 'pos-zomato' },
      { adapterId: 'zomato' },
      { adapterId: 'bank', accountId: 'zomato-settlement' },
    ],
    matches: [
      {
        name: 'pos_to_zomato_with_commission',
        from: 'pos-zomato',
        to: 'zomato',
        strategy: 'amount_tolerance',
        joinKey: 'merchantRefId',
        expectedNetPaise: gross => zomatoExpectedNetPaise(gross),
        tolerancePaise: 100,
      },
      {
        name: 'zomato_batch_to_bank',
        from: 'zomato',
        to: 'bank',
        strategy: 'sum_then_match',
        joinKey: 'utr',
        aggregateBy: 'settlementId',
        tolerancePaise: 0,
      },
    ],
  });

  // ── Config 6: Seller Inventory ↔ Zepto ↔ Bank ────────────────────────────
  registerConfig({
    id: 'restaurant-zepto',
    name: 'Seller Inventory ↔ Zepto ↔ Bank',
    description:
      "Reconciles a seller's dispatch records against Zepto settlements (18% commission + 18% GST + 1% TCS) and the bank credit.",
    sources: [
      { adapterId: 'pos-zepto' },
      { adapterId: 'zepto' },
      { adapterId: 'bank', accountId: 'zepto-settlement' },
    ],
    matches: [
      {
        name: 'seller_to_zepto_with_commission',
        from: 'pos-zepto',
        to: 'zepto',
        strategy: 'amount_tolerance',
        joinKey: 'merchantRefId',
        expectedNetPaise: gross => zeptoExpectedNetPaise(gross),
        tolerancePaise: 100,
      },
      {
        name: 'zepto_batch_to_bank',
        from: 'zepto',
        to: 'bank',
        strategy: 'sum_then_match',
        joinKey: 'utr',
        aggregateBy: 'settlementId',
        tolerancePaise: 0,
      },
    ],
  });

  // ── Config 7: Tally ERP AR Invoices ↔ Bank ───────────────────────────────
  registerConfig({
    id: 'erp-bank-tally',
    name: 'Tally ERP AR Invoices ↔ Bank',
    description:
      'Reconciles accounts-receivable invoices from Tally ERP against bank credits. ' +
      'Customers deduct TDS at source (default 10%, override per-row); expected bank credit = invoice gross × (1 − tdsRate). ' +
      'Joins on invoice number (merchantRefId).',
    sources: [
      { adapterId: 'erp-tally' },
      { adapterId: 'bank', accountId: 'ar-receivables' },
    ],
    matches: [
      {
        name: 'tally_invoice_to_bank_with_tds',
        from: 'erp-tally',
        to: 'bank',
        strategy: 'amount_tolerance',
        joinKey: 'merchantRefId',
        expectedNetPaise: (gross, txn) => tallyExpectedNetPaise(gross, txn),
        tolerancePaise: 100,
      },
    ],
  });

  // ── Config 8: YES Bank UPI Settlement (Phase 3 pilot) ──────────────────
  //
  // Multi-leg cascade per the SOP. Deterministic-only: `llm: 'off'` means
  // unmatched residual goes to the exception bucket without LLM involvement.
  //
  //   Leg 1: PG MIS  ↔  PG Incoming        (composite key: UTR + amount + payer VPA)
  //   Leg 2: ↳ matched  ↔  internal-pg-db  (confirms our py_id exists for the txn)
  //   Leg 3: ↳ matched  anti-join  Consolidated  (drop already-settled rows)
  //   Leg 4: ↳ remaining  ↔  bank YES statement  (batched cash truth)
  //   Leg 5: anything still unmatched → exception bucket (auto-emitted by workflow)
  //
  // Composite key rationale (see docs/RECONCILIATION_AUTOMATION_PROPOSAL.md §7
  // Risk #9): NPCI RRN can collide across PGs and across retry attempts within
  // one PG; (UTR, amount, payer_vpa) together disambiguate. Transforms apply
  // `digits_only` and `strip_whitespace` to defeat Excel data drift.
  registerConfig({
    id: 'settlement-yes-pg',
    name: 'YES Bank UPI Settlement',
    description:
      'Multi-leg settlement reconciliation for YES Bank UPI per the finance team\'s SOP. ' +
      'Deterministic-only (no LLM in decision path); composite (UTR+amount+VPA) key to ' +
      'survive NPCI RRN collisions; final exception report drives manual review.',
    llm: 'off',
    workflow: 'settlement-recon',
    expected_resolution_days: 2,
    sources: [
      { adapterId: 'pg-yes-mis' },
      { adapterId: 'pg-yes-incoming' },
      { adapterId: 'pg-yes-consolidated' },
      { adapterId: 'bank', accountId: 'yes-current' },
      // internal-pg-db is currently a Phase 1.6 stub. When RECO_INTERNAL_PG_DB_URL
      // is unset, leg 2 yields no matches — that's safe for pilot (rows still
      // flow through the rest of the pipeline). Marked `optional: true` so the
      // fetch step doesn't reject the whole run on empty.
      // Production wires the DSN to activate the real py_id cross-check and
      // we can drop the optional flag.
      {
        adapterId: 'internal-pg-db',
        options: { pgName: 'yes', candidates: [] },
        optional: true,
      },
      // NOTE: yes-auto-refunds is intentionally NOT a fetch-at-start source.
      // It's a lookup-by-RRN: the deterministic-match step first runs the legs,
      // finds the "Success in MIS but missing everywhere" RRNs, and queries
      // open_prod for ONLY those RRNs (see workflow.ts → auto-refund lookup).
    ],
    matches: [], // empty — legs[] takes over
    legs: [
      {
        id: 'leg-1-mis-vs-incoming',
        name: 'PG MIS ↔ PG Incoming (composite key)',
        description: 'Confirm each MIS row exists in our internal PG Incoming record. Composite key disambiguates RRN collisions.',
        matches: [
          {
            name: 'mis_incoming_composite_exact',
            ruleId: 'leg1_composite_exact_match',
            from: 'pg-yes-mis',
            to: 'pg-yes-incoming',
            joinKey: { composite: ['utr', 'amountPaise', 'payerVpa'] },
            // Per-field transforms: digits_only is right for the numeric RRN
            // but destroys an alphanumeric UPI VPA (`name@bank` → '' →
            // disqualified). Normalise the VPA with case + whitespace instead.
            transformsByField: {
              utr: ['digits_only', 'strip_whitespace'],
              payerVpa: ['lowercase', 'strip_whitespace'],
            },
            strategy: 'exact',
          },
        ],
        outputs: { carryForward: 'matched', asSource: 'leg1_matched' },
      },
      {
        id: 'leg-2-internal-db-crosscheck',
        name: 'Cross-check py_id in internal PG DB',
        description: 'Looks up matched rows in our internal pg_transactions table to populate py_id. Stub in v1 — activates when RECO_INTERNAL_PG_DB_URL is set.',
        matches: [
          {
            name: 'db_crosscheck_by_utr',
            ruleId: 'leg2_db_crosscheck',
            from: 'leg1_matched',
            to: 'internal-pg-db',
            joinKey: 'utr',
            transforms: ['digits_only'],
            strategy: 'exact',
          },
        ],
        // Pass-through semantics for v1: the DB stub returns empty, so
        // carryForward='all' means "matched-by-DB + everything not yet
        // resolved" flows on. Once RECO_INTERNAL_PG_DB_URL is wired and the
        // real lookup is implemented (Phase 3 follow-up), tighten this to
        // 'matched' so only DB-confirmed rows reach leg 3.
        outputs: { carryForward: 'all', asSource: 'leg2_matched' },
      },
      {
        id: 'leg-3-antijoin-consolidated',
        name: 'Anti-join against Consolidated (already-settled)',
        description: 'Drops any row whose RRN+amount appears in the Consolidated already-settled report. We never re-settle.',
        matches: [
          {
            name: 'antijoin_consolidated',
            ruleId: 'leg3_excluded_in_consolidated',
            from: 'leg2_matched',
            to: 'pg-yes-consolidated',
            joinKey: { composite: ['utr', 'amountPaise'] },
            transforms: ['digits_only'],
            strategy: 'exclude_if_present',
          },
        ],
        outputs: { carryForward: 'unmatched', asSource: 'leg3_carried' },
      },
      {
        id: 'leg-4-bank-settlement',
        name: 'Match against YES Bank statement (batched)',
        description: 'Confirms the cash arrived. YES Bank credits settlements in batches; we sum by settlementId and match the batch to a single bank credit.',
        matches: [
          {
            name: 'bank_credit_by_utr',
            ruleId: 'leg4_bank_credit_exact',
            from: 'leg3_carried',
            to: 'bank',
            joinKey: 'utr',
            transforms: ['digits_only'],
            strategy: 'exact',
          },
        ],
      },
    ],
  });

  console.log(
    '[reco] registered configs: bank-pg-internal, bank-pg-razorpay, bank-pg-cashfree, ' +
    'restaurant-swiggy, restaurant-zomato, restaurant-zepto, erp-bank-tally, settlement-yes-pg'
  );
}

// Top-level call so importing this file is enough in dev mode.
ensureConfigsRegistered();
