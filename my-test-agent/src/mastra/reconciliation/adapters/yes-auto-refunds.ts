/**
 * yes-auto-refunds adapter — pulls UPI auto-refund records live from open_prod.
 *
 * Source of truth for the "Auto Refunded" disposition category. The finance
 * team's Metabase query (UPI Transactions Auto Refund SQL Query) reads
 * `icp_gateway_yesbank_upi_refunds` joined to `pg_transactions`. We run the
 * same query, scoped to the run date's transactions, and return one
 * NormalizedTxn per refund record keyed by `bank_rrn` (the original txn's NPCI
 * RRN — matches the MIS "Customer Ref No." → our `utr`).
 *
 * The disposition engine then looks up each MIS row's `utr` against these and
 * classifies by `pg_refund_status_code`:
 *   'S'         → auto_refund_success (no action)
 *   'F'         → auto_refund_failed  (money not returned — exception)
 *   '' / null   → auto_refund_pending (exception)
 * A MIS-success row with NO refund record here → not auto-refunded (the engine
 * routes it to not_settled_checking).
 *
 * SAFETY:
 *   - Read-only. Single parameterised SELECT. No writes, ever.
 *   - Gated behind RECO_OPEN_PROD_URL. When unset (dev / no DB access) the
 *     adapter returns [] and logs loudly — auto-refund candidates then fall to
 *     'Not Settled (Checking Internally)'. Nothing is silently marked refunded
 *     without evidence from this table.
 *   - The connection is opened, queried, and closed per run; no pooling held.
 *
 * NOTE: untested against the live DB from this environment — validate the
 * status counts against the recon person's Metabase numbers before trusting
 * the auto-refund categories in production.
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';

/** Options passed by the workflow: the candidate RRNs to look up (lookup-by-RRN). */
export interface YesAutoRefundsOptions {
  /** Original-transaction RRNs (MIS Customer Ref No. / utr) to look up in the refunds table. */
  candidates?: string[];
}

/** Postgres has a 65535 bound-parameter cap; chunk RRNs well under it. */
const RRN_BATCH_SIZE = 1000;

/**
 * Build the auto-refund query for a batch of candidate RRNs. Mirrors the finance
 * Metabase query (same json_extract_path_text / any_value semantics) but the
 * optional Metabase template filters are replaced with a single
 * `r.bank_rrn IN (...)` constraint scoped to the candidate RRNs — so we only
 * pull refunds for the "success but missing everywhere" MIS rows.
 *
 * `$1..$n` = the candidate RRNs.
 */
function autoRefundSqlForBatch(count: number): string {
  const placeholders = Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ');
  return `
    SELECT
      r.bank_rrn AS original_transaction_id,
      json_extract_path_text(r.response_data, 'cust_ref_id') AS refund_rrn,
      date(t.created_at) AS transaction_date,
      any_value(r.refund_amount::numeric(10,2)) AS refund_amount,
      any_value(r.status) AS status,
      any_value(r.pg_refund_status_code) AS pg_refund_status_code,
      any_value(json_extract_path_text(r.response_data, 'payer_virtual_address')) AS payer_vpa,
      any_value(t.vpa) AS payee_vpa,
      any_value(r.refund_reason) AS refund_reason,
      r.created_at AS refund_date
    FROM open_prod.icp_gateway_yesbank_upi_refunds r
    LEFT JOIN open_prod.pg_transactions t ON r.bank_rrn = t.pg_txn_ref_num
    WHERE (r.pg_refund_status_code IN ('S','F') OR TRIM(r.pg_refund_status_code) = '' OR r.pg_refund_status_code IS NULL)
      AND r.bank_rrn IN (${placeholders})
    GROUP BY r.bank_rrn, json_extract_path_text(r.response_data, 'cust_ref_id'), date(t.created_at), r.created_at
    ORDER BY r.created_at DESC
  `;
}

function refundRowToTxn(r: Record<string, unknown>, date: string): NormalizedTxn {
  const bankRrn = r.original_transaction_id == null ? '' : String(r.original_transaction_id);
  const amountRupees = Number(r.refund_amount ?? 0);
  const code = r.pg_refund_status_code == null ? '' : String(r.pg_refund_status_code).trim();
  return {
    sourceId: `refund_${bankRrn}_${r.refund_rrn ?? ''}`,
    source: 'yes-auto-refunds',
    // Keyed on the ORIGINAL txn RRN so the disposition engine matches it
    // against MIS.utr (Customer Ref No.).
    utr: bankRrn,
    amountPaise: Math.round(amountRupees * 100),
    date,
    payerVpa: r.payer_vpa == null ? null : String(r.payer_vpa),
    raw: {
      _refundStatusCode: code,                                  // 'S' | 'F' | ''
      _refundStatus: r.status == null ? '' : String(r.status),
      refund_rrn: r.refund_rrn ?? '',
      refund_amount: String(r.refund_amount ?? ''),
      refund_reason: r.refund_reason == null ? '' : String(r.refund_reason),
      refund_date: r.refund_date == null ? '' : String(r.refund_date),
      payee_vpa: r.payee_vpa == null ? '' : String(r.payee_vpa),
    },
  };
}

async function fetchAutoRefunds(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
  const opts = ctx.options as YesAutoRefundsOptions | undefined;
  const candidates = (opts?.candidates ?? []).filter(Boolean);

  if (candidates.length === 0) {
    // No missing-success RRNs to look up (e.g. called at fetch-all time before
    // the legs run, or genuinely nothing to check). Nothing to do.
    return [];
  }

  const dsn = process.env.RECO_OPEN_PROD_URL;
  if (!dsn) {
    console.warn(
      `[yes-auto-refunds] RECO_OPEN_PROD_URL is unset — skipping the live auto-refund lookup for ` +
      `${candidates.length} candidate RRN(s). MIS-success rows with no internal record will route to ` +
      `'Not Settled (Checking Internally)' rather than being classified as auto-refunded. ` +
      `Set a read-only open_prod DSN to enable the real check.`,
    );
    return [];
  }

  // Lazy import so the pg driver only loads when the DSN is configured.
  const { Client } = await import('pg');
  const client = new Client({ connectionString: dsn });
  const t0 = Date.now();
  const out: NormalizedTxn[] = [];
  try {
    await client.connect();
    for (let i = 0; i < candidates.length; i += RRN_BATCH_SIZE) {
      const batch = candidates.slice(i, i + RRN_BATCH_SIZE);
      const res = await client.query(autoRefundSqlForBatch(batch.length), batch);
      for (const r of res.rows as Record<string, unknown>[]) out.push(refundRowToTxn(r, ctx.date));
    }
    console.log(
      `[yes-auto-refunds] looked up ${candidates.length} candidate RRN(s) → ${out.length} refund record(s) ` +
      `in ${Date.now() - t0}ms`,
    );
    return out;
  } catch (err) {
    // Fail soft: a DB error must not crash the whole settlement run. Log loudly;
    // the auto-refund candidates will fall to 'Not Settled (Checking Internally)'.
    console.error(
      `[yes-auto-refunds] live query FAILED for ${candidates.length} RRN(s): ${(err as Error).message}. ` +
      `Auto-refund classification is unavailable for this run — affected rows route to ` +
      `'Not Settled (Checking Internally)'.`,
    );
    return [];
  } finally {
    await client.end().catch(() => { /* ignore close errors */ });
  }
}

export const yesAutoRefundsAdapter: SourceAdapter = {
  id: 'yes-auto-refunds',
  name: 'YES Bank UPI Auto-Refunds (open_prod live)',
  kind: 'internal',
  // No parseFile — this is a live DB source, never uploaded.
  fetch: fetchAutoRefunds,
};
