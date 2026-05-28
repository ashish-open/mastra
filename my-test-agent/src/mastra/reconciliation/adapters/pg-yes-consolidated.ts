/**
 * YES PG Consolidated Adapter — parses the "already-settled-to-merchant" report.
 *
 * This is the anti-join input for Leg 3 of the YES settlement workflow.
 * Any row present here was instant-settled to the merchant in a prior run
 * and MUST NOT be re-settled. The leg drops MIS rows whose RRN appears here.
 *
 * File shape (30 columns observed):
 *   companies_id, company_name, email, open_pg_txn_id, pg_txn_ref_num,
 *   pg_txn_ref_numtxn_amountpayer_vpa (concatenated VLOOKUP helper),
 *   payment_request_id, payer_vpa, payer_name, payee_vpa, txn_amount,
 *   payment_gateways_name, pg_transaction_status, ss_status, created_at,
 *   settled_to_open_date, settled_to_merchant_date,
 *   settlements_txn_id (note: PLURAL — diverges from PG Incoming's settlement_txn_id),
 *   live_account_balance_histories_id's,
 *   pg_fee, pg_tax, pg_total_fee, pg_net_amount,
 *   open_tdr, open_gst, convenience_fee, instant_settlement_charge,
 *   open_total_charges, open_net_amount, transaction_type.
 *
 * Pluralisation gotcha: this file uses `settlements_txn_id` (plural) where
 * PG Incoming uses `settlement_txn_id` (singular). We accept both.
 *
 * For anti-join purposes we only need to surface the join keys (utr, amount,
 * payerVpa, pyId) so leg 3 can match against them. The rich fee columns are
 * retained in `raw` for the eventual report-pack rendering.
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';
import { parseTabularAsStrings, padToLength, pickColumn } from './_csv-utils.js';

const SOURCE_ID = 'pg-yes-consolidated';

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
    console.warn(`[pg-yes-consolidated] zero-padded ${padReport.count} pg_txn_ref_num values.`);
  }

  const txns: NormalizedTxn[] = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const utr = pickColumn(row, 'pg_txn_ref_num');
    const pyId = pickColumn(row, 'open_pg_txn_id');
    const payerVpa = pickColumn(row, 'payer_vpa');
    const amountPaise = rupeesToPaise(pickColumn(row, 'txn_amount', 'amount'));
    const date = normalizeDate(pickColumn(row, 'created_at', 'transaction_date', 'settled_to_merchant_date'));

    if (amountPaise === 0 && !utr && !pyId) continue;

    txns.push({
      sourceId: `yescons_${i}_${pyId ?? utr ?? 'noref'}`,
      source: SOURCE_ID,
      mode: 'UPI',
      amountPaise,
      date,
      utr: utr ?? null,
      merchantRefId: pickColumn(row, 'payment_request_id') ?? null,
      payerVpa: payerVpa ?? null,
      pyId: pyId ?? null,
      // Accept both singular and plural spellings (real-data divergence).
      settlementId: pickColumn(row, 'settlements_txn_id', 'settlement_txn_id') ?? null,
      counterparty: pickColumn(row, 'company_name', 'payer_name') ?? null,
      description: pickColumn(row, 'transaction_type') ?? '',
      raw: {
        ...row,
        _pgFee: pickColumn(row, 'pg_fee') ?? '',
        _pgTax: pickColumn(row, 'pg_tax') ?? '',
        _pgTotalFee: pickColumn(row, 'pg_total_fee') ?? '',
        _pgNetAmount: pickColumn(row, 'pg_net_amount') ?? '',
        _openTdr: pickColumn(row, 'open_tdr') ?? '',
        _openGst: pickColumn(row, 'open_gst') ?? '',
        _openNetAmount: pickColumn(row, 'open_net_amount') ?? '',
        _settledToOpenDate: pickColumn(row, 'settled_to_open_date') ?? '',
        _settledToMerchantDate: pickColumn(row, 'settled_to_merchant_date') ?? '',
      },
    });
  }
  return txns;
}

export const pgYesConsolidatedAdapter: SourceAdapter = {
  id: SOURCE_ID,
  name: 'YES PG Consolidated (already-settled)',
  kind: 'internal',
  parseFile,
};
