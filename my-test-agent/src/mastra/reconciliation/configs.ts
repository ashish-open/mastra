/**
 * Reconciliation configs — registers adapters and declarative match graphs.
 *
 * Both `ensureConfigsRegistered()` AND the top-level call at the end of this
 * file register the same set. The function is idempotent (the registry uses a
 * Map, so re-registering just overwrites). This belt-and-braces approach
 * works around aggressive bundler dead-code elimination: even if a bundler
 * strips the top-level call, the workflow step can call the function
 * directly at runtime.
 *
 * To add a NEW reco type (Zomato, Amazon, GST, etc.):
 *   1. Write a new SourceAdapter in adapters/
 *   2. registerAdapter(...) inside ensureConfigsRegistered()
 *   3. registerConfig({ sources, matches }) inside ensureConfigsRegistered()
 *   4. Pick the config id when triggering the workflow
 */

import { registerAdapter, registerConfig } from './adapter.js';
import { internalLedgerAdapter } from './adapters/internal-ledger.js';
import { zwitchPGAdapter } from './adapters/pg-zwitch.js';
import { bankStatementAdapter } from './adapters/bank-statement.js';
import { swiggyAdapter, restaurantPOSAdapter, swiggyExpectedNetPaise } from './adapters/swiggy.js';

/** Sentinel exported so consumers' `import { RECO_CONFIGS_LOADED }` keeps the file alive. */
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
  registerAdapter(restaurantPOSAdapter);

  // ── Config 1: Bank ↔ PG ↔ Internal ────────────────────────────────────────
  registerConfig({
    id: 'bank-pg-internal',
    name: 'Bank ↔ PG ↔ Internal Ledger',
    description: 'Standard 3-way reco for SaaS/e-com merchants using a payment gateway.',
    sources: [
      { adapterId: 'internal' },
      { adapterId: 'pg-zwitch' },
      { adapterId: 'bank', accountId: 'axis' },
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

  // ── Config 2: Restaurant ↔ Swiggy ↔ Bank ──────────────────────────────────
  registerConfig({
    id: 'restaurant-swiggy',
    name: 'Restaurant POS ↔ Swiggy ↔ Bank',
    description:
      "Reconciles a restaurant's POS orders against Swiggy settlements (with 22% commission + GST + 1% TCS) and then the bank credit.",
    sources: [
      { adapterId: 'pos' },
      { adapterId: 'swiggy' },
      { adapterId: 'bank', accountId: 'axis' },
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

  console.log('[reco] registered configs: bank-pg-internal, restaurant-swiggy');
}

// Top-level call so importing this file is enough in dev mode.
// If a bundler strips this in prod, ensureConfigsRegistered() is still
// callable lazily from the workflow.
ensureConfigsRegistered();
