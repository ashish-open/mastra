/**
 * YES Bank MIS Adapter — parses the daily MIS report from the YES Bank portal.
 *
 * File shape (41 columns observed in the May 2026 sample workbook):
 *   `PG Merchant ID`, `Legal Name`, `Store Name`, `MCC`, `Order No`, `Trans Ref No.`,
 *   `Customer Ref No.` ← NPCI RRN (12-digit), `NPCI Response Code`, `Trans Type`,
 *   `DR/CR`, `Transaction Status`, `Transaction Remarks`, `Transaction Date`,
 *   `Transaction Amount`, `Payer A/c No.`, `Payer Virtual Address` ← VPA,
 *   `Payer A/C Name`, `Payer IFSC Code`, `Payee A/C No`, `Payee Virtual Address`,
 *   `Payee A/C Name`, `Payee IFSC Code`, `Pay Type`, `Device Type`, `App`,
 *   `Device OS`, `Device Mobile No`, `Device Location`, `Ip Address`,
 *   `Settlement Status`, `Settlement Date`, `MSF Amount`, `MSF Tax Amount`,
 *   `Payout Status`, `Trnsaction Id` (sic) ← YES Bank's internal txn id,
 *   `Payer A/c Type`, plus a concatenated VLOOKUP helper + manual flag columns.
 *
 * Terminology gotchas (per src/mastra/reconciliation/TERMINOLOGY.md):
 *   - YES MIS has NO column literally called UTR. The 12-digit NPCI RRN
 *     lives in `Customer Ref No.` — confusing because that name sounds like
 *     the merchant's own ref. We map it to `NormalizedTxn.utr`.
 *   - `Trans Ref No.` is the merchant-side reference we set when initiating;
 *     maps to `NormalizedTxn.merchantRefId`.
 *   - `Trnsaction Id` (yes, the typo is theirs) is YES Bank's internal txn id;
 *     informational — we keep it in `raw` but don't use it as a join key.
 *
 * Phase 1 invariants honoured:
 *   - All ID columns are read as STRINGS (no auto-coercion → leading-zero safe)
 *   - 12-digit NPCI RRN is zero-padded if Excel ate the leading zero
 *   - mode='UPI' for now — the YES MIS file is UPI-only per the partner's SOP.
 *     If/when YES ships separate CC/DC files we'll branch on the file type.
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';
import { parseTabularAsStrings, padToLength, pickColumn } from './_csv-utils.js';

const SOURCE_ID = 'pg-yes-mis';

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
  // Accepts both CSV and XLSX. The shared helper sniffs the mime/extension
  // and routes to the right parser. Both paths return the same shape with
  // identifiers preserved as strings.
  const parsed = await parseTabularAsStrings(file, mime, { lowercaseHeaders: true });
  if (parsed.rows.length === 0) return [];

  // Zero-pad the 12-digit NPCI RRN if Excel touched the file.
  const padReport = padToLength(parsed.rows, 'customer ref no.', 12);
  if (padReport.count > 0) {
    console.warn(
      `[pg-yes-mis] zero-padded ${padReport.count} 'Customer Ref No.' values to 12 digits ` +
      `(Excel likely stripped leading zeros). Samples: ${padReport.samples.map(s => `${s.raw}→${s.padded}`).join(', ')}`,
    );
  }

  const txns: NormalizedTxn[] = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const utr = pickColumn(row, 'customer ref no.', 'customer ref no');
    const merchantRefId = pickColumn(row, 'trans ref no.', 'trans ref no', 'order no');
    const payerVpa = pickColumn(row, 'payer virtual address', 'payer vpa');
    const amountPaise = rupeesToPaise(pickColumn(row, 'transaction amount', 'txn amount', 'amount'));
    const date = normalizeDate(pickColumn(row, 'transaction date', 'txn date', 'transaction_date'));
    const npciCode = pickColumn(row, 'npci response code', 'npci_response_code');
    const txnStatus = pickColumn(row, 'transaction status', 'status');
    const yesTxnId = pickColumn(row, 'trnsaction id', 'transaction id'); // typo is YES Bank's

    // Skip rows that have no amount AND no identifier — defensive against
    // trailing summary rows some MIS exports include.
    if (amountPaise === 0 && !utr && !merchantRefId) continue;

    txns.push({
      sourceId: `yesmis_${i}_${utr ?? merchantRefId ?? 'noref'}`,
      source: SOURCE_ID,
      mode: 'UPI',
      amountPaise,
      date,
      utr: utr ?? null,
      merchantRefId: merchantRefId ?? null,
      payerVpa: payerVpa ?? null,
      // YES `Trnsaction Id` is informational. Our internal `pyId` comes from
      // the cross-check leg against `internal-pg-db`, not from the MIS file.
      pyId: null,
      description: pickColumn(row, 'transaction remarks', 'remarks') ?? '',
      counterparty: pickColumn(row, 'legal name', 'store name', 'payer a/c name') ?? null,
      raw: {
        ...row,
        _yesMisTxnId: yesTxnId ?? '',
        _npciResponseCode: npciCode ?? '',
        _transactionStatus: txnStatus ?? '',
        _settlementStatus: pickColumn(row, 'settlement status') ?? '',
        _payoutStatus: pickColumn(row, 'payout status') ?? '',
        _drCr: pickColumn(row, 'dr/cr') ?? '',
      },
    });
  }
  return txns;
}

export const pgYesMisAdapter: SourceAdapter = {
  id: SOURCE_ID,
  name: 'YES Bank MIS Report',
  kind: 'pg',
  parseFile,
};
