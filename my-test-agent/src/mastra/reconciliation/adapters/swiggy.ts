/**
 * Swiggy Adapter — restaurant aggregator settlements.
 *
 * Swiggy emails a daily/weekly settlement CSV to the restaurant. Schema
 * (canonical for this adapter — real Swiggy reports have different headers
 * which we'd map in production):
 *
 *   order_id,delivered_at,gross_amount,commission,gst_on_commission,tcs,net_payout,settlement_batch_id,utr
 *
 * The adapter:
 *   - Treats each order line as one NormalizedTxn
 *   - amountPaise = net_payout (what Swiggy actually sends to the bank)
 *   - merchantRefId = order_id (so the matcher can join to the POS)
 *   - settlementId = settlement_batch_id (so Match B can sum-and-match to bank)
 *   - utr = the bank UTR Swiggy used
 *
 * Commission model is exposed as expectedNetPaise() so the match config can
 * verify "what Swiggy paid us" ≈ "what we expected for that gross sale".
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';

/**
 * Swiggy fee model (approximate, configurable per restaurant in production):
 *
 *   commission_rate     = 22%
 *   gst_on_commission   = 18% (charged on the commission itself)
 *   tcs_rate            = 1%  (under Section 52, on gross_amount)
 *
 *   expected_net = gross
 *                 - (gross × 0.22)              ← commission
 *                 - (gross × 0.22 × 0.18)       ← GST on commission
 *                 - (gross × 0.01)              ← TCS
 */
export function swiggyExpectedNetPaise(grossPaise: number): number {
  const commission = grossPaise * 0.22;
  const gstOnComm = commission * 0.18;
  const tcs = grossPaise * 0.01;
  return Math.round(grossPaise - commission - gstOnComm - tcs);
}

// ─── Mock CSV (the user can replace by uploading a real file later) ──────────

const MOCK_SWIGGY_CSV = `order_id,delivered_at,gross_amount,commission,gst_on_commission,tcs,net_payout,settlement_batch_id,utr
SW-2026-001,2026-05-13,500.00,110.00,19.80,5.00,365.20,STL-SW-0513-A,SWIG20260513001
SW-2026-002,2026-05-13,1245.00,273.90,49.30,12.45,909.35,STL-SW-0513-A,SWIG20260513001
SW-2026-003,2026-05-13,750.00,165.00,29.70,7.50,547.80,STL-SW-0513-A,SWIG20260513001
SW-2026-004,2026-05-13,320.50,70.51,12.69,3.21,233.59,STL-SW-0513-A,SWIG20260513001
SW-2026-005,2026-05-13,999.00,219.78,39.56,9.99,729.67,STL-SW-0513-A,SWIG20260513001
`;

function parseSwiggyCSV(csv: string, _date: string): NormalizedTxn[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.toLowerCase());
  const col = (row: string[], name: string) => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? row[idx] : undefined;
  };

  const txns: NormalizedTxn[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',').map(c => c.trim());
    const grossRupees = parseFloat(col(row, 'gross_amount') ?? '0');
    const netRupees = parseFloat(col(row, 'net_payout') ?? '0');
    if (Number.isNaN(grossRupees) || Number.isNaN(netRupees)) continue;

    const orderId = col(row, 'order_id') ?? `swiggy_${i}`;
    txns.push({
      sourceId: `swiggy_${orderId}`,
      source: 'pg',                              // canonical source label
      date: col(row, 'delivered_at') ?? '',
      amountPaise: Math.round(netRupees * 100),
      merchantRefId: orderId,                    // ← matches POS order_id
      settlementId: col(row, 'settlement_batch_id') ?? null,
      utr: col(row, 'utr') ?? null,
      counterparty: 'Swiggy',
      description: `Swiggy net payout for order ${orderId}`,
      raw: {
        platform: 'swiggy',
        grossPaise: Math.round(grossRupees * 100),
        commissionPaise: Math.round(parseFloat(col(row, 'commission') ?? '0') * 100),
        gstPaise: Math.round(parseFloat(col(row, 'gst_on_commission') ?? '0') * 100),
        tcsPaise: Math.round(parseFloat(col(row, 'tcs') ?? '0') * 100),
      },
    });
  }
  return txns;
}

export const swiggyAdapter: SourceAdapter = {
  id: 'swiggy',
  name: 'Swiggy',
  kind: 'marketplace',
  async fetch(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    // No public Swiggy API for restaurants — they email reports.
    // Return mock data so the demo runs.
    return parseSwiggyCSV(MOCK_SWIGGY_CSV, ctx.date);
  },
  async parseFile(file: Buffer, mime: string, ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    if (!mime.includes('csv')) {
      throw new Error(`Swiggy adapter expects CSV; got '${mime}'`);
    }
    return parseSwiggyCSV(file.toString('utf-8'), ctx.date);
  },
};

// Convenience: a POS adapter that mimics the restaurant's own order DB. In
// real life this is "internal" again; we add a separate id so the same demo
// can run alongside the bank-PG one.
import { mockInternalLedger } from '../mock-data.js';

export const restaurantPOSAdapter: SourceAdapter = {
  id: 'pos',
  name: 'Restaurant POS',
  kind: 'internal',
  async fetch(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    // Re-using the internal mock but renaming refs to match Swiggy order ids
    // so the demo produces actual joins. In prod this is a real DB query.
    const base = mockInternalLedger(ctx.date);
    // Map them onto Swiggy order ids so the match graph has join keys
    const swiggyIds = ['SW-2026-001', 'SW-2026-002', 'SW-2026-003', 'SW-2026-004', 'SW-2026-005'];
    return base.map((t, i) => ({
      ...t,
      sourceId: `pos_${swiggyIds[i] ?? t.sourceId}`,
      merchantRefId: swiggyIds[i] ?? t.merchantRefId,
      description: `POS order ${swiggyIds[i] ?? '?'} — ${t.description}`,
      counterparty: 'Restaurant POS',
    }));
  },
};
