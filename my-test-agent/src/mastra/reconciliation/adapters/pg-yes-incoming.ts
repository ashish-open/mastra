/**
 * YES PG Incoming Adapter — parses the internal PG Incoming report (our record
 * of every transaction we routed through YES Bank UPI).
 *
 * File shape (20 columns observed in the May 2026 sample):
 *   companies_id, company_name, email, open_pg_txn_id, pg_txn_ref_num,
 *   pg_txn_ref_numamountpayer_vpa (concatenated VLOOKUP helper),
 *   payment_request_id, payer_vpa, payer_name, payee_vpa, amount,
 *   pg_transaction_status, ss_status, transaction_date,
 *   settled_to_merchant_date, settlement_txn_id, payment_gateways_name,
 *   transaction_type_name, name.
 *
 * Mapping to NormalizedTxn:
 *   pg_txn_ref_num     → utr            (NPCI RRN — primary join key)
 *   open_pg_txn_id     → pyId           (our internal PG transaction id)
 *   payer_vpa          → payerVpa       (composite-key disambiguator for UPI)
 *   amount             → amountPaise    (rupees → paise)
 *   transaction_date   → date
 *
 * Phase 1 invariants:
 *   - ID columns read as STRINGS (parseCsvAsStrings); leading-zero safe
 *   - 12-digit NPCI RRN zero-padded if needed
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';
import { parseTabularAsStrings, padToLength, pickColumn } from './_csv-utils.js';

const SOURCE_ID = 'pg-yes-incoming';

function rupeesToPaise(v: string | undefined): number {
  if (!v) return 0;
  const cleaned = v.replace(/[₹,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function normalizeDate(s: string | undefined): string {
  if (!s) return '';
  const v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  // DD-MM-YYYY (per the sample: '21-05-2026 09:05:12')
  const dm = v.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (dm) return `${dm[3]}-${dm[2]}-${dm[1]}`;
  return v.slice(0, 10);
}

async function parseFile(file: Buffer, mime: string, _ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
  // Accepts both CSV and XLSX (mime-sniffed by the shared helper).
  const parsed = await parseTabularAsStrings(file, mime, { lowercaseHeaders: true });
  if (parsed.rows.length === 0) return [];

  const padReport = padToLength(parsed.rows, 'pg_txn_ref_num', 12);
  if (padReport.count > 0) {
    console.warn(
      `[pg-yes-incoming] zero-padded ${padReport.count} pg_txn_ref_num values to 12 digits.`,
    );
  }

  const txns: NormalizedTxn[] = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const utr = pickColumn(row, 'pg_txn_ref_num', 'pg txn ref num');
    const pyId = pickColumn(row, 'open_pg_txn_id', 'open pg txn id');
    const payerVpa = pickColumn(row, 'payer_vpa', 'payer vpa');
    const amountPaise = rupeesToPaise(pickColumn(row, 'amount', 'txn_amount'));
    const date = normalizeDate(pickColumn(row, 'transaction_date', 'txn_date'));

    if (amountPaise === 0 && !utr && !pyId) continue;

    txns.push({
      sourceId: `yespgin_${i}_${pyId ?? utr ?? 'noref'}`,
      source: SOURCE_ID,
      mode: 'UPI',
      amountPaise,
      date,
      utr: utr ?? null,
      merchantRefId: pickColumn(row, 'payment_request_id') ?? null,
      payerVpa: payerVpa ?? null,
      pyId: pyId ?? null,
      settlementId: pickColumn(row, 'settlement_txn_id', 'settlement txn id') ?? null,
      counterparty: pickColumn(row, 'company_name', 'payer_name') ?? null,
      description: pickColumn(row, 'transaction_type_name') ?? '',
      raw: {
        ...row,
        _pgTransactionStatus: pickColumn(row, 'pg_transaction_status') ?? '',
        _ssStatus: pickColumn(row, 'ss_status') ?? '',
        _settledToMerchantDate: pickColumn(row, 'settled_to_merchant_date') ?? '',
        _paymentGateway: pickColumn(row, 'payment_gateways_name') ?? '',
      },
    });
  }
  return txns;
}

export const pgYesIncomingAdapter: SourceAdapter = {
  id: SOURCE_ID,
  name: 'YES PG Incoming (internal)',
  kind: 'internal',
  parseFile,
};
