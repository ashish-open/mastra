/**
 * Razorpay PG Adapter — three data paths, one NormalizedTxn[] output.
 *
 *   1. parseFile(buf, mime, ctx)
 *      Parses the daily "Settlement Recon Report" CSV from the dashboard.
 *      Canonical columns:
 *        transaction_entity, entity_id, amount, currency, fee (exclusive tax),
 *        tax, debit, credit, payment_method, card_type, issuer_name,
 *        entity_created_at, payment_captured_at, payment_notes, refund_notes,
 *        arn, entity_description, order_id, order_receipt, order_notes,
 *        dispute_id, dispute_created_at, dispute_reason,
 *        settlement_id, settled_at, settlement_utr, settled_by
 *      Amounts in PAISE. Per-row net = credit − debit.
 *
 *   2. fetch(ctx) via Razorpay MCP server  ← NEW
 *      Calls fetch_settlement_recon_details on https://mcp.razorpay.com/mcp
 *      when RAZORPAY_USE_MCP=1 is set. Same Basic auth using
 *      RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET.
 *
 *   3. fetch(ctx) via direct Razorpay REST  ← FALLBACK
 *      Calls GET /v1/settlements/recon/combined directly when MCP is disabled
 *      or unreachable.
 *
 * Toggle:
 *   RAZORPAY_USE_MCP=1 → prefer MCP, fall through to REST on failure
 *   unset / RAZORPAY_USE_MCP=0 → REST only
 *
 * Without RAZORPAY_KEY_ID/_SECRET both fetch paths throw and the workflow
 * surfaces "upload a CSV or set env vars."
 *
 * Fee model (for reference):
 *   fee  = 2% of gross
 *   tax  = 18% GST on fee
 *   net  = gross - fee - tax
 */

import type { SourceAdapter, SourceAdapterContext } from '../adapter.js';
import type { NormalizedTxn } from '../types.js';
import { callRazorpayTool, razorpayRecoTools } from '../../tools/razorpay-mcp.js';

/** Convenience used by configs.ts for the amount_tolerance expectedNetPaise. */
export function razorpayExpectedNetPaise(grossPaise: number): number {
  const fee = grossPaise * 0.02;
  const gstOnFee = fee * 0.18;
  return Math.round(grossPaise - fee - gstOnFee);
}

// ─── CSV parsing (real Razorpay settlement recon report) ─────────────────────

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

/** Razorpay recon CSVs use DD/MM/YYYY HH:MM:SS — normalize to YYYY-MM-DD. */
function normalizeDate(s: string | undefined): string {
  if (!s) return '';
  const v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v;
}

function parseRazorpayCSV(csv: string): NormalizedTxn[] {
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

    const entityType = (col(row, 'transaction_entity') ?? '').toLowerCase();
    // Settlement summary rows duplicate per-txn rows. Skip — the workflow only
    // needs per-payment/refund granularity.
    if (entityType === 'settlement') continue;

    const paymentId = col(row, 'entity_id') ?? `rzp_entity_${i}`;
    const grossPaise = parseInt(col(row, 'amount') ?? '0', 10) || 0;
    const feePaise = parseInt(col(row, 'fee (exclusive tax)', 'fee') ?? '0', 10) || 0;
    const taxPaise = parseInt(col(row, 'tax') ?? '0', 10) || 0;
    const creditPaise = parseInt(col(row, 'credit') ?? '0', 10) || 0;
    const debitPaise = parseInt(col(row, 'debit') ?? '0', 10) || 0;
    const amountPaise = creditPaise - debitPaise;

    const orderId = col(row, 'order_id') ?? `rzp_ord_${i}`;
    txns.push({
      sourceId: `rzp_${paymentId}`,
      source: 'pg',
      date: normalizeDate(col(row, 'settled_at')),
      amountPaise,
      merchantRefId: orderId,
      settlementId: col(row, 'settlement_id') ?? null,
      utr: col(row, 'settlement_utr', 'utr') ?? null,
      counterparty: 'Razorpay',
      description: `Razorpay ${entityType || 'txn'} for order ${orderId}`,
      raw: { platform: 'razorpay', grossPaise, feePaise, taxPaise, paymentId, entityType },
    });
  }
  return txns;
}

// ─── Live API fetch ──────────────────────────────────────────────────────────

interface RzpReconItem {
  entity_id: string;
  type: string;
  amount: number;             // paise
  fee: number;                // paise
  tax: number;                // paise
  credit: number;             // paise
  debit: number;              // paise
  order_id: string | null;
  settlement_id: string | null;
  settled_at: number;         // unix seconds
  settlement_utr?: string | null;
  utr?: string | null;
}

/** Validate credentials are present before any API/MCP attempt. */
function requireCreds(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error(
      'Razorpay API credentials missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET ' +
      'env vars to enable live fetch, or upload the Settlement Recon CSV via /reco/upload.'
    );
  }
  return { keyId, keySecret };
}

/** Convert a recon-API row into our canonical NormalizedTxn. */
function reconItemToTxn(it: RzpReconItem): NormalizedTxn {
  const amountPaise = (it.credit ?? 0) - (it.debit ?? 0);
  // settled_at may be a unix-seconds number OR an ISO string (MCP sometimes
  // serializes timestamps differently). Handle both.
  let dateStr: string;
  if (typeof it.settled_at === 'number') {
    dateStr = new Date(it.settled_at * 1000).toISOString().slice(0, 10);
  } else {
    dateStr = String(it.settled_at).slice(0, 10);
  }
  return {
    sourceId: `rzp_${it.entity_id}`,
    source: 'pg',
    date: dateStr,
    amountPaise,
    merchantRefId: it.order_id ?? `rzp_ord_${it.entity_id}`,
    settlementId: it.settlement_id,
    utr: it.settlement_utr ?? it.utr ?? null,
    counterparty: 'Razorpay',
    description: `Razorpay ${it.type} for order ${it.order_id ?? '(no order)'}`,
    raw: {
      platform: 'razorpay',
      grossPaise: it.amount,
      feePaise: it.fee,
      taxPaise: it.tax,
      paymentId: it.entity_id,
      entityType: it.type,
    },
  };
}

// ─── Path A: Fetch via Razorpay MCP server ───────────────────────────────────
// Hosted at https://mcp.razorpay.com/mcp; tool name `fetch_settlement_recon_details`
// takes year/month/day instead of from/to unix seconds. We paginate 100 at a
// time until the page returns fewer than `count`.
//
// The MCPClient session, auth header, and tool allow-list live in
// src/mastra/tools/razorpay-mcp.ts. The workflow controls which tools the
// reco subsystem may call by editing RAZORPAY_RECO_TOOL_NAMES there — adapter
// code is restricted to whatever's been allow-listed.

async function fetchViaMcp(date: string): Promise<NormalizedTxn[]> {
  // Sanity-check the allow-list at call time so a misconfigured workflow
  // fails with a clearer error than "tool not loaded".
  if (!razorpayRecoTools['razorpay_fetch_settlement_recon_details']) {
    throw new Error(
      'Razorpay MCP tool fetch_settlement_recon_details is not in the reco allow-list ' +
      'or the MCP failed to load. Check RAZORPAY_RECO_TOOL_NAMES in tools/razorpay-mcp.ts ' +
      'and the [razorpay-mcp] startup logs.'
    );
  }
  // requireCreds throws the same operator-facing error as the REST path when
  // env vars are missing — it's idempotent against the MCP client's startup
  // check, kept for symmetry.
  requireCreds();

  // YYYY-MM-DD → integers (Razorpay's MCP wants raw numbers, not strings).
  const [yStr, mStr, dStr] = date.split('-');
  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10);
  const day = parseInt(dStr, 10);

  interface ReconPage { items?: RzpReconItem[]; count?: number }

  const items: RzpReconItem[] = [];
  const PAGE_SIZE = 100;
  let skip = 0;
  // Paginate up to 50 pages (5,000 rows) as a sanity cap.
  for (let page = 0; page < 50; page++) {
    const payload = await callRazorpayTool<ReconPage | RzpReconItem[]>(
      'fetch_settlement_recon_details',
      { year, month, day, count: PAGE_SIZE, skip },
    );
    // Razorpay returns { count, entity: 'collection', items: [...] }
    // OR sometimes just an array — handle both.
    const pageItems = Array.isArray(payload) ? payload : payload.items ?? [];
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  console.log(`[reco] Razorpay MCP returned ${items.length} recon rows for ${date}`);
  return items
    .filter(it => (it.type ?? '').toLowerCase() !== 'settlement')
    .map(reconItemToTxn);
}

// ─── Path B: Fetch via direct Razorpay REST (fallback) ───────────────────────
// https://razorpay.com/docs/api/payments/settlements/#fetch-settlement-recon

async function fetchViaRest(date: string): Promise<NormalizedTxn[]> {
  const { keyId, keySecret } = requireCreds();

  // recon-combined wants unix seconds; pass the full day in IST.
  const from = Math.floor(new Date(`${date}T00:00:00+05:30`).getTime() / 1000);
  const to = Math.floor(new Date(`${date}T23:59:59+05:30`).getTime() / 1000);
  const url = `https://api.razorpay.com/v1/settlements/recon/combined?from=${from}&to=${to}&count=1000`;
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Razorpay API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json() as { items?: RzpReconItem[] };
  const items = json.items ?? [];

  console.log(`[reco] Razorpay REST returned ${items.length} recon rows for ${date}`);
  return items
    .filter(it => (it.type ?? '').toLowerCase() !== 'settlement')
    .map(reconItemToTxn);
}

/**
 * Dispatcher: prefers MCP if RAZORPAY_USE_MCP=1, falls back to REST on MCP
 * failure (network, auth, tool error). This way operators can opt into MCP
 * progressively without losing the existing REST path as a safety net.
 */
async function fetchRazorpaySettlements(date: string): Promise<NormalizedTxn[]> {
  const useMcp = process.env.RAZORPAY_USE_MCP === '1';
  if (useMcp) {
    try {
      return await fetchViaMcp(date);
    } catch (e) {
      console.warn(`[reco] Razorpay MCP failed, falling back to REST: ${(e as Error).message}`);
      return fetchViaRest(date);
    }
  }
  return fetchViaRest(date);
}

export const razorpayPGAdapter: SourceAdapter = {
  id: 'pg-razorpay',
  name: 'Razorpay Payment Gateway',
  kind: 'pg',
  async fetch(ctx: SourceAdapterContext): Promise<NormalizedTxn[]> {
    return fetchRazorpaySettlements(ctx.date);
  },
  async parseFile(file: Buffer, mime: string): Promise<NormalizedTxn[]> {
    if (!mime.includes('csv') && !mime.includes('text/plain')) {
      throw new Error(`Razorpay adapter expects CSV; got '${mime}'`);
    }
    return parseRazorpayCSV(file.toString('utf-8'));
  },
};
