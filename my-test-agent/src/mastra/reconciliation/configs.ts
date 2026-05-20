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

  console.log(
    '[reco] registered configs: bank-pg-internal, bank-pg-razorpay, bank-pg-cashfree, ' +
    'restaurant-swiggy, restaurant-zomato, restaurant-zepto, erp-bank-tally'
  );
}

// Top-level call so importing this file is enough in dev mode.
ensureConfigsRegistered();
