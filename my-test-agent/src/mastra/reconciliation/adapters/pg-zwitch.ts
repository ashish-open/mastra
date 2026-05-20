/**
 * Zwitch PG Adapter — payment-gateway settlements from Zwitch.
 *
 * Currently upload-only. When the Zwitch settlement-recon REST endpoint
 * (or an equivalent SFTP-of-CSV path) is wired, add a fetch() that calls it
 * and returns NormalizedTxn[]. Until then this adapter mirrors the Razorpay
 * shape — payment_id, order_id, settlement_id, settlement_utr, amounts in
 * paise.
 *
 * Expected CSV columns (canonical; case-insensitive):
 *   entity_id | payment_id
 *   order_id
 *   amount        (paise, integer)
 *   fee           (paise, integer)
 *   tax           (paise, integer)
 *   credit        (paise, integer; net to merchant)
 *   debit         (paise, integer; refunds/adjustments)
 *   settlement_id
 *   settled_at    YYYY-MM-DD or DD/MM/YYYY
 *   settlement_utr | utr
 */

import type { SourceAdapter } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';

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

function parseZwitchCSV(csv: string): NormalizedTxn[] {
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
    const paymentId = col(row, 'entity_id', 'payment_id') ?? `zw_${i}`;
    const orderId = col(row, 'order_id') ?? `zw_ord_${i}`;
    const grossPaise = parseInt(col(row, 'amount') ?? '0', 10) || 0;
    const feePaise = parseInt(col(row, 'fee') ?? '0', 10) || 0;
    const taxPaise = parseInt(col(row, 'tax') ?? '0', 10) || 0;
    const credit = parseInt(col(row, 'credit') ?? '0', 10) || 0;
    const debit = parseInt(col(row, 'debit') ?? '0', 10) || 0;

    txns.push({
      sourceId: `zw_${paymentId}`,
      source: 'pg',
      date: normalizeDate(col(row, 'settled_at', 'date')),
      amountPaise: credit - debit,
      merchantRefId: orderId,
      settlementId: col(row, 'settlement_id') ?? null,
      utr: col(row, 'settlement_utr', 'utr') ?? null,
      counterparty: 'Zwitch',
      description: `Zwitch settlement for order ${orderId}`,
      raw: { platform: 'zwitch', grossPaise, feePaise, taxPaise, paymentId },
    });
  }
  return txns;
}

export const zwitchPGAdapter: SourceAdapter = {
  id: 'pg-zwitch',
  name: 'Zwitch Payment Gateway',
  kind: 'pg',
  // No fetch() yet — wire when Zwitch settlement-recon endpoint is available.
  async parseFile(file: Buffer, mime: string): Promise<NormalizedTxn[]> {
    if (!mime.includes('csv') && !mime.includes('text/plain')) {
      throw new Error(`Zwitch adapter expects CSV; got '${mime}'`);
    }
    return parseZwitchCSV(file.toString('utf-8'));
  },
};
