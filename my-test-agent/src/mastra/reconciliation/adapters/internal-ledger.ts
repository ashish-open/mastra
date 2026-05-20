/**
 * Internal Ledger Adapter — reads the merchant's own transaction log.
 *
 * TWO data paths, both producing NormalizedTxn[]:
 *
 * (1) fetch(ctx) — direct query against the merchant's Postgres
 *     Driven entirely by env so we don't bake schema assumptions into code:
 *       MERCHANT_DB_URL          REQUIRED to enable fetch path.
 *                                Standard PG connection string.
 *       MERCHANT_LEDGER_QUERY    Optional. Defaults to:
 *                                  SELECT id, transaction_date, amount_paise,
 *                                         merchant_ref_id, counterparty, description
 *                                  FROM merchant_ledger
 *                                  WHERE transaction_date = $1
 *                                Must accept ONE positional param ($1 = date).
 *                                Must return the named columns; aliases below
 *                                are used to map to NormalizedTxn fields.
 *
 *     Expected column → NormalizedTxn field mapping:
 *       id               → sourceId   (auto-prefixed with 'int_')
 *       transaction_date → date
 *       amount_paise     → amountPaise        (integer paise)
 *       merchant_ref_id  → merchantRefId
 *       counterparty     → counterparty
 *       description      → description
 *
 *     If MERCHANT_DB_URL is missing, fetch() throws and the workflow falls
 *     through to "upload a CSV" guidance.
 *
 * (2) parseFile(buf, mime, ctx) — CSV upload
 *     For merchants who can't expose a DB connection. Expected columns
 *     (case-insensitive, all optional except amount):
 *       id | sourceId,
 *       date | transaction_date,
 *       amount_paise | amount,      ← if 'amount', treated as rupees
 *       merchant_ref_id | order_id | reference,
 *       counterparty,
 *       description
 *
 *     This same adapter is reused for the 'pos' source under restaurant /
 *     marketplace configs by registering it twice with different IDs — the
 *     parser handles both shapes.
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';
import pg from 'pg';

const DEFAULT_LEDGER_QUERY = `
  SELECT id, transaction_date, amount_paise, merchant_ref_id, counterparty, description
  FROM merchant_ledger
  WHERE transaction_date = $1
`;

// Lazy pool — one connection across calls; closed on process exit.
let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.MERCHANT_DB_URL;
  if (!url) {
    throw new Error(
      'Internal ledger fetch requires MERCHANT_DB_URL env var. ' +
      'Either set it (PG connection string) or upload a ledger CSV via /reco/upload.'
    );
  }
  _pool = new pg.Pool({ connectionString: url, max: 4 });
  return _pool;
}

async function fetchInternalLedger(date: string): Promise<NormalizedTxn[]> {
  const pool = getPool();
  const sql = process.env.MERCHANT_LEDGER_QUERY ?? DEFAULT_LEDGER_QUERY;
  const result = await pool.query(sql, [date]);
  return result.rows.map((r: Record<string, unknown>) => ({
    sourceId: `int_${String(r.id)}`,
    source: 'internal' as const,
    date: typeof r.transaction_date === 'string'
      ? r.transaction_date.slice(0, 10)
      : (r.transaction_date instanceof Date ? r.transaction_date.toISOString().slice(0, 10) : date),
    amountPaise: Number(r.amount_paise ?? 0),
    merchantRefId: (r.merchant_ref_id as string) ?? null,
    counterparty: (r.counterparty as string) ?? null,
    description: (r.description as string) ?? undefined,
    raw: { source: 'merchant_db', rowId: r.id },
  }));
}

// ─── CSV path (shared with the POS adapter) ─────────────────────────────────

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

export function parseInternalLedgerCSV(
  csv: string,
  idPrefix: string,
  defaultCounterparty?: string,
): NormalizedTxn[] {
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

  // If the file lists "amount_paise", trust it as integer paise.
  // If only "amount" is present, treat as rupees with decimals.
  const headerHasPaise = headers.includes('amount_paise');

  const txns: NormalizedTxn[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = splitCSVLine(lines[i]);
    const rawId = col(row, 'id', 'sourceid', 'source_id') ?? `${i}`;

    let amountPaise: number;
    if (headerHasPaise) {
      amountPaise = parseInt(col(row, 'amount_paise') ?? '0', 10) || 0;
    } else {
      const rupees = parseFloat((col(row, 'amount') ?? '0').replace(/[₹,\s]/g, ''));
      amountPaise = Number.isNaN(rupees) ? 0 : Math.round(rupees * 100);
    }

    txns.push({
      sourceId: `${idPrefix}_${rawId}`,
      source: 'internal',
      date: normalizeDate(col(row, 'date', 'transaction_date', 'voucher_date')),
      amountPaise,
      merchantRefId: col(row, 'merchant_ref_id', 'order_id', 'reference', 'voucher_number') ?? null,
      counterparty: col(row, 'counterparty', 'party_name') ?? defaultCounterparty ?? null,
      description: col(row, 'description', 'notes') ?? undefined,
      raw: { source: 'csv-upload' },
    });
  }
  return txns;
}

export const internalLedgerAdapter: SourceAdapter = {
  id: 'internal',
  name: 'Internal Ledger',
  kind: 'internal',
  async fetch(_ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    return fetchInternalLedger(_ctx.date);
  },
  async parseFile(file: Buffer, mime: string): Promise<NormalizedTxn[]> {
    if (!mime.includes('csv') && !mime.includes('text/plain')) {
      throw new Error(`Internal ledger adapter expects CSV; got '${mime}'`);
    }
    return parseInternalLedgerCSV(file.toString('utf-8'), 'int');
  },
};
