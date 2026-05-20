/**
 * Bank Statement Adapter — parses uploaded bank statements.
 *
 * Upload-only. Indian banks do not publish a programmatic daily-statement API
 * that's broadly available, so the only viable production path is the
 * download-and-upload flow.
 *
 * Expected CSV columns (canonical — what we ask banks to export as):
 *   date           YYYY-MM-DD or DD/MM/YYYY
 *   amount         rupees with optional decimals (₹/comma stripped)
 *                  OR amount_paise (integer paise) if the export gives raw paise
 *   utr            bank UTR / RRN
 *   description    free-form narration
 *   counterparty   name on the other side of the transfer
 *   type           credit | debit (optional; sign of `amount` is the source of truth)
 *
 * XLSX / PDF parsers are TODO — each is a separate library install we can add
 * when a particular bank's preferred format demands it (xlsx, pdf-parse).
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
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

// Parse a rupee value (with optional ₹, commas, whitespace) → paise.
// Empty/whitespace/dash → 0. Used because Indian-bank exports leave the
// "wrong-side" column blank for every row (Credit empty on debit rows).
function rupeesToPaise(raw: string | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === 'NIL') return 0;
  const cleaned = trimmed.replace(/[₹,\s]/g, '');
  const v = parseFloat(cleaned);
  return Number.isNaN(v) ? 0 : Math.round(v * 100);
}

function parseCSV(body: string, source: string): NormalizedTxn[] {
  const lines = body.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map(h => h.toLowerCase());
  const col = (row: string[], ...names: string[]): string | undefined => {
    for (const name of names) {
      const idx = headers.indexOf(name);
      if (idx >= 0) return row[idx];
    }
    return undefined;
  };

  // Three shapes a bank statement can take:
  //   (a) integer paise            — header `amount_paise`
  //   (b) signed rupees            — header `amount` (positive=credit, negative=debit, OR `type` col disambiguates)
  //   (c) separate credit/debit    — headers `credit` + `debit` (standard HDFC/ICICI/Axis exports)
  const hasPaise = headers.includes('amount_paise');
  const hasCreditDebit = headers.includes('credit') && headers.includes('debit');

  const txns: NormalizedTxn[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = splitCSVLine(lines[i]);

    let amountPaise = 0;
    if (hasPaise) {
      amountPaise = parseInt(col(row, 'amount_paise') ?? '0', 10) || 0;
    } else if (hasCreditDebit) {
      // Credit = money in (positive); Debit = money out (negate).
      const credit = rupeesToPaise(col(row, 'credit', 'cr', 'deposit'));
      const debit = rupeesToPaise(col(row, 'debit', 'dr', 'withdrawal'));
      amountPaise = credit - debit;
    } else {
      const rupees = parseFloat((col(row, 'amount') ?? '0').replace(/[₹,\s]/g, ''));
      if (Number.isNaN(rupees)) continue;
      amountPaise = Math.round(rupees * 100);
      // Honor an explicit `type=debit` column by negating positive amounts.
      const type = (col(row, 'type') ?? '').toLowerCase();
      if (type === 'debit' && amountPaise > 0) amountPaise = -amountPaise;
    }

    // Skip header-like rows that produced zero amount AND no UTR (defensive
    // against trailing summary lines some banks include).
    const utr = col(row, 'utr', 'reference', 'ref_no', 'ref no.', 'rrn') ?? null;
    if (amountPaise === 0 && !utr) continue;

    txns.push({
      sourceId: `bank_${source}_${i}_${utr ?? 'noutr'}`,
      source: 'bank',
      date: normalizeDate(col(row, 'date', 'transaction_date', 'txn_date', 'txn date', 'value_date', 'value date')),
      amountPaise,
      utr,
      description: col(row, 'description', 'narration', 'particulars') ?? '',
      counterparty: col(row, 'counterparty', 'party') ?? null,
      merchantRefId: col(row, 'merchant_ref_id', 'reference_id', 'remarks') ?? null,
      raw: { ...Object.fromEntries(headers.map((h, j) => [h, row[j]])), _bank: source },
    });
  }
  return txns;
}

export const bankStatementAdapter: SourceAdapter = {
  id: 'bank',
  name: 'Bank Statement',
  kind: 'bank',
  // No fetch() — Indian banks don't expose daily-statement APIs publicly.
  async parseFile(file: Buffer, mime: string, ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    const source = ctx.accountId ?? 'bank';
    const text = file.toString('utf-8');
    if (mime === 'text/csv' || mime === 'application/csv' || mime.endsWith('csv') || mime.includes('text/plain')) {
      return parseCSV(text, source);
    }
    throw new Error(
      `Bank statement parser doesn't support mime '${mime}' yet. CSV is supported; ` +
      `xlsx/pdf are TODO — convert the statement to CSV from your bank portal for now.`
    );
  },
};
