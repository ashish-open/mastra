/**
 * Internal Ledger Adapter — reads transactions from our own DB.
 *
 * Currently returns mock data; swap fetch() body for a real DB query when
 * wiring to production.
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';
import { mockInternalLedger } from '../mock-data.js';

export const internalLedgerAdapter: SourceAdapter = {
  id: 'internal',
  name: 'Internal Ledger',
  kind: 'internal',
  async fetch(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    // TODO: real DB query.
    //   const rows = await db.transactions.findMany({ where: { date: ctx.date } });
    //   return rows.map(toNormalized);
    return mockInternalLedger(ctx.date);
  },
};
