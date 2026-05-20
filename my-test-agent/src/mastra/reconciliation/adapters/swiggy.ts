/**
 * Swiggy Adapter — restaurant aggregator settlement reports.
 *
 * Swiggy emails a daily/weekly settlement CSV to the restaurant — there's no
 * public seller API, so this adapter is upload-only.
 *
 * Expected CSV columns (case-insensitive, aliases shown):
 *   order_id
 *   delivered_at | date
 *   gross_amount | order_value                          (rupees)
 *   commission                                          (rupees)
 *   gst_on_commission | gst                             (rupees)
 *   tcs                                                 (rupees)
 *   net_payout | net_settlement | net                   (rupees)
 *   settlement_batch_id | settlement_id
 *   utr
 *
 * Fee model (for the matcher's expectedNetPaise hook):
 *   commission_rate    = 22%
 *   gst_on_commission  = 18% (on the commission amount)
 *   tcs_rate           = 1%  (under Section 52, on gross)
 *   expected_net       = gross × (1 − 0.22 − 0.22×0.18 − 0.01) = gross × 0.7404
 */

import type { SourceAdapter } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';

export function swiggyExpectedNetPaise(grossPaise: number): number {
  const commission = grossPaise * 0.22;
  const gstOnComm = commission * 0.18;
  const tcs = grossPaise * 0.01;
  return Math.round(grossPaise - commission - gstOnComm - tcs);
}

function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuote = !inQuote;
      continue;
    }
    if (ch === ',' && !inQuote) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normalizeDate(s: string | undefined): string {
  if (!s) return '';
  const v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v;
}

const toPaise = (s: string | undefined): number => {
  if (!s) return 0;
  const v = parseFloat(s.replace(/[₹,\s]/g, ''));
  return Number.isNaN(v) ? 0 : Math.round(v * 100);
};

function parseSwiggyCSV(csv: string): NormalizedTxn[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map(h => h.toLowerCase());
  const col = (row: string[], ...names: string[]): string | undefined => {
    for (const name of names) {
      const idx = headers.indexOf(name);
      if (idx >= 0) return row[idx];
    }
    return undefined;
  };

  const txns: NormalizedTxn[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = splitCSVLine(lines[i]);
    const orderId = col(row, 'order_id') ?? `swiggy_${i}`;
    const grossPaise = toPaise(col(row, 'gross_amount', 'order_value'));
    const commissionPaise = toPaise(col(row, 'commission'));
    const gstPaise = toPaise(col(row, 'gst_on_commission', 'gst'));
    const tcsPaise = toPaise(col(row, 'tcs'));
    const netPaise = toPaise(col(row, 'net_payout', 'net_settlement', 'net'))
      || (grossPaise - commissionPaise - gstPaise - tcsPaise);

    txns.push({
      sourceId: `swiggy_${orderId}`,
      source: 'pg',
      date: normalizeDate(col(row, 'delivered_at', 'date')),
      amountPaise: netPaise,
      merchantRefId: orderId,
      settlementId: col(row, 'settlement_batch_id', 'settlement_id') ?? null,
      utr: col(row, 'utr') ?? null,
      counterparty: 'Swiggy',
      description: `Swiggy net payout for order ${orderId}`,
      raw: { platform: 'swiggy', grossPaise, commissionPaise, gstPaise, tcsPaise },
    });
  }
  return txns;
}

export const swiggyAdapter: SourceAdapter = {
  id: 'swiggy',
  name: 'Swiggy',
  kind: 'marketplace',
  // No fetch() — Swiggy doesn't expose a seller API.
  async parseFile(file: Buffer, mime: string): Promise<NormalizedTxn[]> {
    if (!mime.includes('csv') && !mime.includes('text/plain')) {
      throw new Error(`Swiggy adapter expects CSV; got '${mime}'`);
    }
    return parseSwiggyCSV(file.toString('utf-8'));
  },
};
