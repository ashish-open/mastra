/**
 * Cashfree PG Adapter — fetches settlements via API + parses uploaded recon reports.
 *
 * parseFile(buf, mime, ctx)
 *   Cashfree Settlement Report CSV. The dashboard's columns vary slightly by
 *   account; this parser accepts the common shape:
 *     order_id, cf_payment_id (or payment_id), settlement_date, payment_amount
 *     (or gross_amount / amount), service_charge (or fee), service_tax (or tax),
 *     settlement_amount (or net_amount), settlement_id, utr.
 *   Amounts are RUPEES with two decimals.
 *
 * fetch(ctx)
 *   GET https://api.cashfree.com/pg/settlements?from={date}&to={date}
 *   Requires app credentials in env:
 *     CASHFREE_APP_ID, CASHFREE_SECRET_KEY  [, CASHFREE_API_VERSION]
 *   Optional CASHFREE_BASE_URL override for sandbox (defaults to prod).
 *
 * Fee model:
 *   fee = 1.75% of gross
 *   tax = 18% GST on fee
 *   net = gross - fee - tax
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';

export function cashfreeExpectedNetPaise(grossPaise: number): number {
  const fee = grossPaise * 0.0175;
  const gstOnFee = fee * 0.18;
  return Math.round(grossPaise - fee - gstOnFee);
}

// ─── CSV parsing ─────────────────────────────────────────────────────────────

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
  // DD/MM/YYYY or DD-MM-YYYY
  const m = v.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v;
}

function parseCashfreeCSV(csv: string): NormalizedTxn[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.toLowerCase().trim());
  const col = (row: string[], ...names: string[]): string | undefined => {
    for (const name of names) {
      const idx = headers.indexOf(name);
      if (idx >= 0) return row[idx]?.trim();
    }
    return undefined;
  };

  const toPaise = (rupees: string | undefined): number => {
    if (!rupees) return 0;
    const v = parseFloat(rupees.replace(/[₹,\s]/g, ''));
    return Number.isNaN(v) ? 0 : Math.round(v * 100);
  };

  const txns: NormalizedTxn[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = splitCSVLine(lines[i]);
    const paymentId = col(row, 'cf_payment_id', 'payment_id') ?? `cf_pay_${i}`;
    const orderId = col(row, 'order_id') ?? `cf_ord_${i}`;
    const grossPaise = toPaise(col(row, 'payment_amount', 'gross_amount', 'amount'));
    const feePaise = toPaise(col(row, 'service_charge', 'fee'));
    const taxPaise = toPaise(col(row, 'service_tax', 'tax'));
    const netPaise = toPaise(col(row, 'settlement_amount', 'net_amount'))
      || (grossPaise - feePaise - taxPaise);

    txns.push({
      sourceId: `cf_${paymentId}`,
      source: 'pg',
      date: normalizeDate(col(row, 'settlement_date', 'settled_at', 'date')),
      amountPaise: netPaise,
      merchantRefId: orderId,
      settlementId: col(row, 'settlement_id') ?? null,
      utr: col(row, 'utr', 'settlement_utr') ?? null,
      counterparty: 'Cashfree',
      description: `Cashfree net settlement for order ${orderId}`,
      raw: { platform: 'cashfree', grossPaise, feePaise, taxPaise, paymentId },
    });
  }
  return txns;
}

// ─── Live API fetch ──────────────────────────────────────────────────────────
// https://docs.cashfree.com/reference/pg-settlements-fetch-all

interface CfSettlementRow {
  cf_payment_id?: string;
  payment_id?: string;
  order_id: string;
  payment_amount?: number;
  service_charge?: number;
  service_tax?: number;
  settlement_amount?: number;
  settlement_id?: string;
  utr?: string;
  settled_at?: string;
}

async function fetchCashfreeSettlements(date: string): Promise<NormalizedTxn[]> {
  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!appId || !secret) {
    throw new Error(
      'Cashfree API credentials missing. Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY ' +
      'env vars to enable live fetch, or upload the Settlement Report CSV via /reco/upload.'
    );
  }
  const baseUrl = process.env.CASHFREE_BASE_URL ?? 'https://api.cashfree.com';
  const apiVersion = process.env.CASHFREE_API_VERSION ?? '2025-01-01';

  const url = `${baseUrl}/pg/settlements?from=${date}&to=${date}&limit=1000`;
  const res = await fetch(url, {
    headers: {
      'x-client-id': appId,
      'x-client-secret': secret,
      'x-api-version': apiVersion,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cashfree API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json() as { data?: CfSettlementRow[] } | CfSettlementRow[];
  const items: CfSettlementRow[] = Array.isArray(json) ? json : json.data ?? [];

  return items.map(it => {
    const paymentId = it.cf_payment_id ?? it.payment_id ?? `cf_${it.order_id}`;
    const grossPaise = Math.round((it.payment_amount ?? 0) * 100);
    const feePaise = Math.round((it.service_charge ?? 0) * 100);
    const taxPaise = Math.round((it.service_tax ?? 0) * 100);
    const netPaise = Math.round((it.settlement_amount ?? 0) * 100)
      || (grossPaise - feePaise - taxPaise);
    return {
      sourceId: `cf_${paymentId}`,
      source: 'pg' as const,
      date: (it.settled_at ?? '').slice(0, 10),
      amountPaise: netPaise,
      merchantRefId: it.order_id,
      settlementId: it.settlement_id ?? null,
      utr: it.utr ?? null,
      counterparty: 'Cashfree',
      description: `Cashfree net settlement for order ${it.order_id}`,
      raw: { platform: 'cashfree', grossPaise, feePaise, taxPaise, paymentId },
    };
  });
}

export const cashfreePGAdapter: SourceAdapter = {
  id: 'pg-cashfree',
  name: 'Cashfree Payment Gateway',
  kind: 'pg',
  async fetch(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    return fetchCashfreeSettlements(ctx.date);
  },
  async parseFile(file: Buffer, mime: string): Promise<NormalizedTxn[]> {
    if (!mime.includes('csv') && !mime.includes('text/plain')) {
      throw new Error(`Cashfree adapter expects CSV; got '${mime}'`);
    }
    return parseCashfreeCSV(file.toString('utf-8'));
  },
};
