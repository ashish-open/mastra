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
  const hasAmount = headers.includes('amount');

  // Surface a clear diagnostic when no amount shape was detected. Without this,
  // the adapter silently returns [] and the upload route says "Parsed 0
  // transactions" with no indication of WHY. Common cause: the uploaded file
  // is actually a PG MIS / transaction report rather than a bank statement.
  if (!hasPaise && !hasCreditDebit && !hasAmount) {
    throw new Error(
      `Bank Statement parser found no amount column. Detected headers: ` +
      `[${headers.slice(0, 12).join(', ')}${headers.length > 12 ? ', …' : ''}]. ` +
      `Expected one of: 'amount_paise', 'amount' (+ optional 'type'), or 'credit'+'debit'. ` +
      `If this is a PG transaction report (not a bank credit/debit statement), it should be ` +
      `uploaded to the 'pg-yes-mis' source instead. If it IS a bank statement with a different ` +
      `column name, tell engineering the file's amount-column header so we can add an alias.`,
    );
  }

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
    //
    // Column-name aliases:
    // - YES Bank statements use `URN` and `BANKREFERENCENUMBER` (whichever is
    //   populated) for the RRN — neither matches the conventional `utr`/`rrn`.
    //   Accept both alongside the standard names. See TERMINOLOGY.md.
    const utr = col(
      row,
      'utr', 'reference', 'ref_no', 'ref no.', 'rrn',
      'bankreferencenumber', 'bank reference number', 'urn',
    ) ?? null;
    if (amountPaise === 0 && !utr) continue;

    txns.push({
      sourceId: `bank_${source}_${i}_${utr ?? 'noutr'}`,
      source: 'bank',
      // YES uses `TXN_DATE` / `VALUE_DATE` / `DAT_POST`; HDFC/Axis use the
      // friendlier `transaction_date` / `value_date`. Try all.
      date: normalizeDate(col(row, 'date', 'transaction_date', 'txn_date', 'txn date', 'txn_date', 'value_date', 'value date', 'dat_post')),
      amountPaise,
      utr,
      description: col(row, 'description', 'narration', 'particulars') ?? '',
      counterparty: col(row, 'counterparty', 'party') ?? null,
      merchantRefId: col(row, 'merchant_ref_id', 'reference_id', 'remarks') ?? null,
      raw: { ...Object.fromEntries(headers.map((h, j) => [h, row[j]])), _bank: source },
    });
  }
  // If we recognized a shape but emitted zero rows, surface a diagnostic
  // instead of silently returning []. Lines>1 means there were data rows; if
  // they all got skipped it's usually a UTR-column miss or an amount column
  // that parses to 0 throughout.
  if (txns.length === 0 && lines.length > 1) {
    throw new Error(
      `Bank Statement parser found ${lines.length - 1} data rows but extracted 0 transactions. ` +
      `Detected headers: [${headers.slice(0, 12).join(', ')}${headers.length > 12 ? ', …' : ''}]. ` +
      `Most rows were skipped (amount=0 and no UTR). ` +
      `Check that your amount column actually has values and the reference column matches one of: ` +
      `utr / reference / ref_no / rrn / bankreferencenumber / urn.`,
    );
  }
  return txns;
}

/** Render a ParsedCsv row set back to a CSV string so the existing parseCSV()
 *  pipeline (with all its per-bank shape detection) can consume it unchanged.
 *  Cheap intermediate — runs once per upload, small files. */
function rowsToCsvBody(headers: string[], rows: Record<string, string | number>[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headerLine = headers.map(esc).join(',');
  const bodyLines = rows.map(r => headers.map(h => esc(r[h])).join(','));
  return [headerLine, ...bodyLines].join('\n');
}

export const bankStatementAdapter: SourceAdapter = {
  id: 'bank',
  name: 'Bank Statement',
  kind: 'bank',
  // No fetch() — Indian banks don't expose daily-statement APIs publicly.
  async parseFile(file: Buffer, mime: string, ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    const source = ctx.accountId ?? 'bank';
    const isCsv = mime === 'text/csv' || mime === 'application/csv' || mime.endsWith('csv') || mime.includes('text/plain');
    if (isCsv) {
      return parseCSV(file.toString('utf-8'), source);
    }
    const isXlsx =
      mime.includes('spreadsheetml') ||
      mime.includes('officedocument') ||
      mime.endsWith('xlsx') ||
      mime === 'application/vnd.ms-excel';
    if (isXlsx) {
      // Parse XLSX preserving leading zeros, then synthesize a CSV body so
      // the per-bank parseCSV pipeline (credit/debit detection, URN/UTR
      // aliases, etc.) doesn't need its own XLSX-aware variant.
      const { parseXlsxAsStrings } = await import('./_csv-utils.js');
      const parsed = await parseXlsxAsStrings(file, { lowercaseHeaders: false });
      const body = rowsToCsvBody(parsed.headers, parsed.rows);
      return parseCSV(body, source);
    }
    throw new Error(
      `Bank statement parser doesn't support mime '${mime}'. CSV + XLSX are supported; ` +
      `PDF is TODO.`
    );
  },
};
