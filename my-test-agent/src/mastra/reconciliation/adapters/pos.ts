/**
 * Generic POS Adapter — for restaurant / seller order data that aggregator
 * configs (Swiggy / Zomato / Zepto) reconcile against.
 *
 * Upload-only — POS systems vary widely and don't expose a uniform API.
 *
 * Expected CSV columns (case-insensitive; alias lists shown):
 *   id        | order_id | sourceId        ← merchant_ref_id will match this
 *   date      | transaction_date | order_date
 *   amount    | gross_amount                ← rupees with decimals
 *   amount_paise                            ← OR integer paise (takes priority)
 *   counterparty | customer                 ← optional
 *   description | notes                     ← optional
 *
 * The adapter is registered under THREE ids in configs.ts: `pos`,
 * `pos-zomato`, `pos-zepto`. Each restaurant/seller config picks the id
 * that matches its uploaded file slot — staging is keyed on
 * (configId, adapterId, date) so the same file can't accidentally satisfy
 * the wrong config.
 */

import type { SourceAdapter } from '../adapter.js';
import { parseInternalLedgerCSV } from './internal-ledger.js';

function makePosAdapter(id: string, name: string): SourceAdapter {
  return {
    id,
    name,
    kind: 'internal',
    // No fetch() — POS data is upload-only.
    async parseFile(file, mime): Promise<ReturnType<typeof parseInternalLedgerCSV>> {
      if (!mime.includes('csv') && !mime.includes('text/plain')) {
        throw new Error(`${name} adapter expects CSV; got '${mime}'`);
      }
      // Reuse the internal-ledger parser. idPrefix scopes sourceIds across
      // adapters so multiple POS uploads can't collide.
      return parseInternalLedgerCSV(file.toString('utf-8'), id, 'POS');
    },
  };
}

export const posAdapter: SourceAdapter = makePosAdapter('pos', 'Restaurant POS');
export const posZomatoAdapter: SourceAdapter = makePosAdapter('pos-zomato', 'Restaurant POS (Zomato)');
export const posZeptoAdapter: SourceAdapter = makePosAdapter('pos-zepto', 'Seller Inventory (Zepto)');
