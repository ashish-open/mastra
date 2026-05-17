/**
 * Bank Statement Adapter — supports BOTH live API fetch (when the bank
 * publishes one) AND uploaded statement files (most common path in practice).
 *
 * File-upload flow:
 *   User → /api/upload-statement (with file + source=axis|hdfc|icici)
 *        → adapter.parseFile(buffer, mime, { date, source })
 *        → returns NormalizedTxn[]
 *
 * Supports CSV today. Excel (xlsx) and PDF parsers are stubbed for future work
 * — each is a separate library install (xlsx, pdf-parse) we can add later.
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';
import { mockBankStatement } from '../mock-data.js';

/**
 * Parses a CSV bank statement.
 *
 * Expected columns (canonical, what we'd ask banks to download as):
 *   date,amount,utr,description,counterparty,type
 *
 * Real bank exports have wildly different headers — when we add per-bank
 * format detection, we'll route to format-specific column maps. For now this
 * accepts the canonical schema.
 */
function parseCSV(body: string, source: string): NormalizedTxn[] {
  const lines = body.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Tolerate quoted commas via a tiny CSV parser (RFC 4180 subset).
  // Caveat: doesn't handle escaped quotes inside fields — fine for typical bank exports.
  const splitCSV = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };

  const headers = splitCSV(lines[0]).map(h => h.toLowerCase());
  const col = (row: string[], name: string): string | undefined => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? row[idx] : undefined;
  };

  const txns: NormalizedTxn[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = splitCSV(lines[i]);
    const amountRaw = col(row, 'amount') ?? '0';
    // Treat input as RUPEES with optional decimal — multiply to paise
    const amountRupees = parseFloat(amountRaw.replace(/[₹,\s]/g, ''));
    if (Number.isNaN(amountRupees)) continue;
    const amountPaise = Math.round(amountRupees * 100);

    txns.push({
      sourceId: `bank_csv_${i}_${col(row, 'utr') ?? 'noutr'}`,
      source: 'bank',
      date: col(row, 'date') ?? '',
      amountPaise,
      utr: col(row, 'utr') ?? null,
      description: col(row, 'description') ?? '',
      counterparty: col(row, 'counterparty') ?? null,
      raw: { ...Object.fromEntries(headers.map((h, j) => [h, row[j]])), _bank: source },
    });
  }
  return txns;
}

export const bankStatementAdapter: SourceAdapter = {
  id: 'bank',
  name: 'Bank Statement',
  kind: 'bank',

  async fetch(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    // Most banks don't expose a daily-statement API publicly. The accountId
    // tells us which bank's mock data to return for now.
    const bank = (ctx.accountId ?? 'axis') as 'axis' | 'hdfc' | 'icici';
    return mockBankStatement(ctx.date, bank);
  },

  async parseFile(file: Buffer, mime: string, ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    const source = ctx.accountId ?? 'unknown-bank';
    const text = file.toString('utf-8');
    if (mime === 'text/csv' || mime === 'application/csv' || mime.endsWith('csv')) {
      return parseCSV(text, source);
    }
    // TODO: xlsx (npm install xlsx) and pdf (npm install pdf-parse) parsers
    throw new Error(
      `Bank statement parser doesn't support mime '${mime}' yet. CSV is supported; xlsx/pdf are TODO.`
    );
  },
};
