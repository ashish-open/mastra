/**
 * Tally ERP Adapter — accounts-receivable invoices from Tally Prime / Tally ERP 9.
 *
 * Upload-only. Tally is on-premise and doesn't expose a remote API for our use.
 * Export an AR ledger as CSV from Tally (Reports → Receivables → Export as CSV).
 *
 * Expected CSV columns (case-insensitive):
 *   voucher_number | invoice_number
 *   party_name | customer
 *   voucher_date | invoice_date | date
 *   gross_amount | amount                 (rupees)
 *   tds_rate                              (percent, e.g. 10 = 10%; default 10)
 *   tds_amount                            (rupees, optional)
 *   net_amount                            (rupees, optional — derived if absent)
 *
 * Reconciliation expects:
 *   net_bank_credit ≈ gross × (1 − tds_rate/100)
 */

import type { SourceAdapter } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';

/** Per-row TDS expectation. Default 10% (Section 194J) unless overridden. */
export function tallyExpectedNetPaise(grossPaise: number, txn: NormalizedTxn): number {
  const tdsRate = typeof txn.raw?.tdsRate === 'number' ? (txn.raw.tdsRate as number) : 10;
  return Math.round(grossPaise * (1 - tdsRate / 100));
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

function parseTallyCSV(csv: string): NormalizedTxn[] {
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
    const voucherNumber = col(row, 'voucher_number', 'invoice_number') ?? `inv_${i}`;
    const partyName = col(row, 'party_name', 'customer') ?? 'Unknown';
    const grossPaise = toPaise(col(row, 'gross_amount', 'amount'));
    const tdsRate = parseFloat(col(row, 'tds_rate') ?? '10') || 10;

    txns.push({
      sourceId: `tally_${voucherNumber}`,
      source: 'internal',
      date: normalizeDate(col(row, 'voucher_date', 'invoice_date', 'date')),
      amountPaise: grossPaise,
      merchantRefId: voucherNumber,
      counterparty: partyName,
      description: `Invoice ${voucherNumber} to ${partyName} (TDS ${tdsRate}%)`,
      raw: {
        platform: 'tally',
        tdsRate,
        tdsPaise: toPaise(col(row, 'tds_amount')),
        netAmountPaise: toPaise(col(row, 'net_amount')),
        voucherNumber,
        partyName,
      },
    });
  }
  return txns;
}

export const tallyERPAdapter: SourceAdapter = {
  id: 'erp-tally',
  name: 'Tally ERP (AR Invoices)',
  kind: 'erp',
  async parseFile(file: Buffer, mime: string): Promise<NormalizedTxn[]> {
    if (!mime.includes('csv') && !mime.includes('text/plain')) {
      throw new Error(`Tally ERP adapter expects CSV; got '${mime}'`);
    }
    return parseTallyCSV(file.toString('utf-8'));
  },
};
