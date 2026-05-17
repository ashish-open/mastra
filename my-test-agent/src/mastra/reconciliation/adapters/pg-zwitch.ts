/**
 * Zwitch PG Adapter — reads payment-gateway settlements via API.
 *
 * Currently returns mock data; swap fetch() body for a real Zwitch
 * /v1/settlements call when wiring to production.
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';
import { mockPGSettlements } from '../mock-data.js';

export const zwitchPGAdapter: SourceAdapter = {
  id: 'pg-zwitch',
  name: 'Zwitch Payment Gateway',
  kind: 'pg',
  async fetch(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    // TODO: real API call to Zwitch /v1/settlements?date=...
    return mockPGSettlements(ctx.date);
  },
};
