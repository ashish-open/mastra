/**
 * Report builder — the finance-team deliverable for a reco run.
 *
 * Per the finance team's actual workflow (confirmed 2026-05-27), a run produces
 * exactly TWO MIS-anchored reports:
 *
 *   settlement_report.csv  — MIS rows that reconciled cleanly and are eligible
 *                            to settle. Mirrors the YES MIS file's own columns
 *                            so finance can upload it downstream as-is.
 *   exception_report.csv   — every MIS row that did NOT settle, with the status
 *                            on each side (MIS / PG / bank) and the plain-English
 *                            reason it didn't reconcile.
 *
 * The model is MIS-anchored: the YES Bank MIS is the base file. Every MIS
 * transaction lands in exactly one report (settle → settlement, everything
 * else → exception). settlement.rows + exception.rows == total MIS rows.
 *
 * Both files are driven entirely by the disposition summaries (one per MIS row,
 * emitted by the disposition engine). Leg-level decisions are NOT needed here —
 * the engine already folded them into each MIS row's bucket + status snapshot.
 *
 * Determinism: same inputs → byte-identical output. No timestamps in row
 * contents; rows emitted in input order (exceptions sorted by bucket priority).
 */

import type { ReconcileConfig } from '../adapter.js';
import type { NormalizedTxn, RecoDecision, SettlementBucket } from '../types.js';
import { SETTLEMENT_BUCKET_LABELS, SETTLEMENT_BUCKET_ORDER } from '../types.js';
import { getDispositionRules } from '../disposition/engine.js';
import { toCsv, paiseToRupeeString } from './csv.js';

/**
 * Buckets that need finance action → they belong in the exception report.
 * `settled_instant` (already done) and `settled_next_day` (in the settlement
 * report) are intentionally excluded.
 */
const EXCEPTION_BUCKETS = new Set<SettlementBucket>([
  'awaiting_bank_credit',
  'refund_late_authorized',
  'refund_timeout',
  'auto_refund_failed',   // money NOT returned — action needed
  'auto_refund_pending',  // refund not yet confirmed — monitor
  // auto_refund_success is resolved (money returned) → summary only, NOT an exception
  'ignore_failed',
  'not_settled_checking',
  'no_disposition',
]);

export interface ReportPackWarning {
  source: string;
  column?: string;
  message: string;
  details?: string;
}

export interface ReportPackInput {
  runId: string;
  configId: string;
  /** Reconciliation date (YYYY-MM-DD). */
  date: string;
  config: ReconcileConfig;
  /** Fetched rows per adapter — only the anchor (MIS) source's `raw` is read. */
  fetched: Array<{ adapterId: string; txns: NormalizedTxn[] }>;
  /** Decisions for the run — only disposition summaries (one per MIS row) are used. */
  decisions: RecoDecision[];
  /** Optional upload/parse warnings. Retained in the API but no longer a file. */
  warnings?: ReportPackWarning[];
}

export interface ReportPackFile {
  /** Relative path inside the pack (forward slashes). */
  path: string;
  /** Text contents. */
  contents: string;
}

export interface ReportPackOutput {
  rootDir: string;
  files: ReportPackFile[];
  summary: string;
}

/** Lean per-MIS-row projection used by the exception report (drops `raw`). */
interface LeanTxn {
  utr?: string | null;
  merchantRefId?: string | null;
  pyId?: string | null;
  amountPaise: number;
  date: string;
  payerVpa?: string | null;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Resolve the anchor (MIS) adapter id for a config from its disposition
 * registration. Settlement reports mirror the anchor file's columns, so we
 * need to know which fetched source is the anchor.
 */
function anchorAdapterIdFor(configId: string): string | null {
  return getDispositionRules(configId)?.apply.anchorAdapterId ?? null;
}

/** Original MIS column keys = raw keys excluding parser-internal `_`-prefixed ones. */
function misColumnHeaders(anchorRows: NormalizedTxn[]): string[] {
  const first = anchorRows.find(t => t.raw && Object.keys(t.raw).length > 0);
  if (!first || !first.raw) return [];
  return Object.keys(first.raw).filter(k => !k.startsWith('_'));
}

/**
 * Yields the two finance reports one at a time so the caller writes + frees
 * each before building the next (keeps peak memory low at scale).
 */
export function* iterReportPackFiles(input: ReportPackInput): Generator<ReportPackFile> {
  const { configId, fetched, decisions } = input;

  const anchorId = anchorAdapterIdFor(configId);
  const anchorRows = anchorId
    ? (fetched.find(f => f.adapterId === anchorId)?.txns ?? [])
    : [];

  // MIS raw rows (for settlement mirror) + lean projection (for exception cols).
  const misRawById = new Map<string, Record<string, unknown>>();
  const misLeanById = new Map<string, LeanTxn>();
  for (const t of anchorRows) {
    if (t.raw) misRawById.set(t.sourceId, t.raw as Record<string, unknown>);
    misLeanById.set(t.sourceId, {
      utr: t.utr, merchantRefId: t.merchantRefId, pyId: t.pyId,
      amountPaise: t.amountPaise, date: t.date, payerVpa: t.payerVpa,
    });
  }

  // The only decisions we care about are the per-MIS-row disposition summaries.
  const summaries = decisions.filter(d => d.metadata?.legId === 'disposition_summary');
  // Settlement = rows actually TO BE settled (next-day / T+2). Instant ones are
  // already paid, so they live only in the summary.
  const settleRows = summaries.filter(s => s.metadata?.disposition?.bucket === 'settled_next_day');
  // Exceptions = everything that needs finance action.
  const exceptionRows = summaries.filter(s => EXCEPTION_BUCKETS.has((s.metadata?.disposition?.bucket ?? 'no_disposition') as SettlementBucket));

  // 1) summary.csv — the headline pivot the recon person circulates today
  //    (category → count + ₹ sum), totalling to "Funds Received".
  yield { path: 'summary.csv', contents: buildSummary(summaries, misLeanById) };
  // 2) settlement_report.csv — the to-be-settled (T+2) rows, MIS columns mirrored.
  yield { path: 'settlement_report.csv', contents: buildSettlementReport(settleRows, misRawById, misColumnHeaders(anchorRows)) };
  // 3) exception_report.csv — action-needed rows with per-side status + reason.
  yield { path: 'exception_report.csv', contents: buildExceptionReport(exceptionRows, misLeanById) };
}

/**
 * One-line per-bucket summary for logs. Cheap — iterates summaries only.
 */
export function summarizeReportPack(input: Pick<ReportPackInput, 'decisions'>): string {
  const bucketCounts = new Map<string, number>();
  let total = 0;
  for (const d of input.decisions) {
    if (d.metadata?.legId !== 'disposition_summary') continue;
    total++;
    const b = d.metadata?.disposition?.bucket ?? 'no_disposition';
    bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
  }
  const toSettle = bucketCounts.get('settled_next_day') ?? 0;
  const instant = bucketCounts.get('settled_instant') ?? 0;
  const bucketSummary = Array.from(bucketCounts.entries()).map(([b, n]) => `${b}=${n}`).join(', ');
  return `${total} MIS rows → ${toSettle} to settle (T+2), ${instant} instant-settled (${bucketSummary || 'none'})`;
}

/**
 * Summary pivot — the headline artifact the recon person circulates today.
 * One row per category (count + ₹ sum of MIS Transaction Amount), in the fixed
 * finance order, with a "Funds Received (Total)" grand-total row. Mirrors the
 * Excel pivot exactly so it can replace the manual version.
 */
function buildSummary(summaries: RecoDecision[], misLeanById: Map<string, LeanTxn>): string {
  const counts = new Map<SettlementBucket, number>();
  const paise = new Map<SettlementBucket, number>();
  let totalCount = 0;
  let totalPaise = 0;
  for (const s of summaries) {
    const bucket = (s.metadata?.disposition?.bucket ?? 'no_disposition') as SettlementBucket;
    const amt = misLeanById.get(s.sourceTxnId)?.amountPaise ?? 0;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    paise.set(bucket, (paise.get(bucket) ?? 0) + amt);
    totalCount += 1;
    totalPaise += amt;
  }

  const rows: Record<string, string | number>[] = [];
  for (const bucket of SETTLEMENT_BUCKET_ORDER) {
    const n = counts.get(bucket) ?? 0;
    if (n === 0) continue; // omit empty categories, like the Excel pivot
    rows.push({
      category: SETTLEMENT_BUCKET_LABELS[bucket],
      count: n,
      amount: paiseToRupeeString(paise.get(bucket) ?? 0),
    });
  }
  rows.push({ category: 'Funds Received (Total)', count: totalCount, amount: paiseToRupeeString(totalPaise) });
  return toCsv(rows, ['category', 'count', 'amount']);
}

/** Non-streaming convenience wrapper (collects files into an array). */
export function buildReportPack(input: ReportPackInput): ReportPackOutput {
  const files = Array.from(iterReportPackFiles(input));
  const rootDir = `${input.configId}_${input.date}`;
  return { rootDir, files, summary: `Reports: ${files.length} files, ${summarizeReportPack(input)}` };
}

// ─── Report builders ───────────────────────────────────────────────────────

/**
 * Settlement report — MIS rows bucketed `settle`, output with the MIS file's
 * own columns (so finance uploads it downstream as-is). When the anchor rows
 * carry no `raw` (shouldn't happen for a real MIS upload), falls back to a
 * minimal reference/amount projection.
 */
function buildSettlementReport(
  settleRows: RecoDecision[],
  misRawById: Map<string, Record<string, unknown>>,
  headers: string[],
): string {
  if (headers.length === 0) {
    // Fallback: no MIS raw available — emit a minimal identifiable set.
    const rows = settleRows.map(s => ({ sourceTxnId: s.sourceTxnId }));
    return toCsv(rows, ['sourceTxnId']);
  }
  const rows = settleRows.map(s => {
    const raw = misRawById.get(s.sourceTxnId) ?? {};
    const row: Record<string, string> = {};
    for (const h of headers) {
      const v = raw[h];
      row[h] = v === null || v === undefined ? '' : String(v);
    }
    return row;
  });
  return toCsv(rows, headers);
}

/**
 * Exception report — every MIS row that did not settle. One row per problem
 * transaction with the status on each side and the deterministic reason it
 * didn't reconcile. Ordered by bucket priority (escalations first) so finance
 * works the highest-impact items first.
 */
function buildExceptionReport(
  exceptionRows: RecoDecision[],
  misLeanById: Map<string, LeanTxn>,
): string {
  // Highest-impact (money to move / unknowns) first; no-action last.
  const bucketOrder = new Map<string, number>([
    ['auto_refund_failed', 0],     // customer money not returned — top priority
    ['refund_late_authorized', 1],
    ['refund_timeout', 2],
    ['auto_refund_pending', 3],
    ['awaiting_bank_credit', 4],
    ['not_settled_checking', 5],
    ['no_disposition', 6],
    ['ignore_failed', 7],
  ]);

  const rows = exceptionRows
    .map(s => {
      const mis = misLeanById.get(s.sourceTxnId);
      const d = s.metadata?.disposition;
      const st = (d?.statuses ?? {}) as Record<string, string | boolean>;
      const bucket = d?.bucket ?? 'no_disposition';
      return {
        bucket,
        action: actionForBucket(bucket),
        misRef: mis?.utr ?? '',
        orderRef: mis?.merchantRefId ?? '',
        amount: paiseToRupeeString(mis?.amountPaise ?? null),
        date: mis?.date ?? '',
        misStatus: String(st.misStatus ?? ''),
        npciResponseCode: String(st.npciResponseCode ?? ''),
        pgIncomingStatus: String(st.pgIncomingStatus ?? ''),
        alreadySettled: st.alreadySettled === true ? 'yes' : 'no',
        bankCreditReceived: st.bankCreditReceived === true ? 'yes' : 'no',
        refundStatus: String(st.refundStatusCode ?? ''),
        refundReason: String(st.refundReason ?? ''),
        pyId: mis?.pyId ?? '',
        payerVpa: mis?.payerVpa ?? '',
        reason: d?.reasonText ?? '',
      };
    })
    .sort((a, b) => (bucketOrder.get(a.bucket) ?? 99) - (bucketOrder.get(b.bucket) ?? 99));

  return toCsv(rows, [
    'bucket', 'action', 'misRef', 'orderRef', 'amount', 'date',
    'misStatus', 'npciResponseCode', 'pgIncomingStatus',
    'alreadySettled', 'bankCreditReceived', 'refundStatus', 'refundReason',
    'pyId', 'payerVpa', 'reason',
  ]);
}

/** Short plain-English next-step for the exception report. */
function actionForBucket(bucket: string): string {
  switch (bucket) {
    case 'settled_instant':        return 'Already settled (instant) — no action';
    case 'settled_next_day':       return 'Settle on next-day (T+2) cycle';
    case 'awaiting_bank_credit':   return 'Hold — bank credit not received; settle once credited, else follow up with partner';
    case 'refund_late_authorized': return 'Initiate refund to source account (Late Authorised)';
    case 'refund_timeout':         return 'Initiate refund to source account (Timeout)';
    case 'auto_refund_success':    return 'Auto-refunded successfully — no action';
    case 'auto_refund_failed':     return 'Auto-refund FAILED — money not returned; investigate & re-initiate refund';
    case 'auto_refund_pending':    return 'Auto-refund pending — monitor until success/failed';
    case 'ignore_failed':          return 'No action — failed in both systems, no funds moved';
    case 'not_settled_checking':   return 'Checking internally';
    case 'no_disposition':         return 'Manual review required';
    default:                       return 'Review';
  }
}
