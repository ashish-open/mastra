/**
 * SourceAdapter — uniform interface for every data source we reconcile against.
 *
 * Each adapter knows ONE format (Swiggy CSV, Zomato Excel, Axis PDF, Razorpay
 * API, internal ledger DB, etc.) and emits canonical NormalizedTxn[].
 *
 * Adding a new platform = writing one adapter file + registering it in
 * the global adapter registry. The matcher / workflow doesn't care which
 * platform a txn came from — it sees the canonical shape.
 *
 * Two fetch modes per adapter:
 *   - fetch({date, account}) → for live API integrations (Razorpay, Stripe)
 *   - parseFile(buffer, mime)  → for statement uploads (CSV, Excel, PDF)
 * Adapters typically implement one or both depending on the platform.
 */

import type { NormalizedTxn } from './types.js';

export interface SourceAdapterContext {
  /** ISO date (YYYY-MM-DD) the caller wants data for */
  date: string;
  /** Adapter-specific account / store / merchant identifier */
  accountId?: string;
  /** Free-form per-adapter options (rate cards, brand IDs, etc.) */
  options?: Record<string, unknown>;
}

export interface SourceAdapter {
  /** Stable identifier — used in ReconcileConfig.sources */
  id: string;
  /** Human-readable name for logs/UI */
  name: string;
  /** One of: 'internal', 'pg', 'bank', 'marketplace', 'erp', 'tax', 'logistics' */
  kind: 'internal' | 'pg' | 'bank' | 'marketplace' | 'erp' | 'tax' | 'logistics';

  /** Live fetch — use when the source exposes an API */
  fetch?(ctx: SourceAdapterContext): Promise<NormalizedTxn[]>;

  /**
   * File-upload parse — use when the source delivers via email/portal.
   * mime is the uploaded file's content-type (csv/xlsx/pdf).
   */
  parseFile?(file: Buffer, mime: string, ctx: SourceAdapterContext): Promise<NormalizedTxn[]>;
}

// ─── Global adapter registry (singleton via globalThis) ─────────────────────
//
// Why globalThis instead of a module-level Map: Mastra's build sometimes
// produces multiple module instances (especially when workflows are
// referenced both at startup and inside step execute() closures). A regular
// module Map would end up duplicated → registrations from one instance
// invisible to lookups from another. globalThis is the one shared root that
// every module instance sees the same way.

interface RecoGlobal {
  __recoAdapters?: Map<string, SourceAdapter>;
  __recoConfigs?: Map<string, ReconcileConfig>;
}
const g = globalThis as unknown as RecoGlobal;
g.__recoAdapters ??= new Map<string, SourceAdapter>();

export function registerAdapter(adapter: SourceAdapter): void {
  const reg = g.__recoAdapters!;
  if (reg.has(adapter.id)) {
    console.warn(`[reco] adapter '${adapter.id}' is being re-registered; overwriting.`);
  }
  reg.set(adapter.id, adapter);
}

export function getAdapter(id: string): SourceAdapter {
  const a = g.__recoAdapters!.get(id);
  if (!a) throw new Error(`No adapter registered with id '${id}'. Did you forget to import it?`);
  return a;
}

export function listAdapters(): SourceAdapter[] {
  return Array.from(g.__recoAdapters!.values());
}

// ─── ReconcileConfig — the match graph ───────────────────────────────────────

export interface MatchStrategy {
  name: string;
  /** Adapter id producing the LEFT side of the match */
  from: string;
  /** Adapter id producing the RIGHT side of the match */
  to: string;
  /** Field to join on. Examples: 'merchantRefId', 'utr' */
  joinKey: 'merchantRefId' | 'utr' | 'sourceId';
  /**
   * 'exact'           — 1:1 join on joinKey, amounts must be equal
   * 'amount_tolerance'— 1:1 join, amounts within tolerancePaise
   * 'sum_then_match'  — group LEFT by aggregateBy, sum, then match to RIGHT amount
   */
  strategy: 'exact' | 'amount_tolerance' | 'sum_then_match';
  /** For 'sum_then_match' — which field on LEFT defines the aggregation group */
  aggregateBy?: 'settlementId';
  /** Allowed amount delta in paise. Default 0 for 'exact'. */
  tolerancePaise?: number;
  /**
   * For marketplace reco: function predicting expected NET payout from a
   * source row's gross amount. Useful when the bank credit ≠ raw sum because
   * commission/tax/TCS was deducted by the platform.
   */
  expectedNetPaise?: (gross: number, txn: NormalizedTxn) => number;
}

export interface ReconcileConfig {
  /** Stable id used to invoke a specific reco from the workflow */
  id: string;
  name: string;
  description: string;
  /** Adapters to fetch from at the start of the run */
  sources: { adapterId: string; accountId?: string; options?: Record<string, unknown> }[];
  /** Ordered match steps. Each runs against the accumulated data. */
  matches: MatchStrategy[];
}

// ─── Global config registry (same globalThis pattern) ──────────────────────

g.__recoConfigs ??= new Map<string, ReconcileConfig>();

export function registerConfig(config: ReconcileConfig): void {
  const reg = g.__recoConfigs!;
  if (reg.has(config.id)) {
    console.warn(`[reco] config '${config.id}' is being re-registered; overwriting.`);
  }
  reg.set(config.id, config);
}

export function getConfig(id: string): ReconcileConfig {
  const c = g.__recoConfigs!.get(id);
  if (!c) {
    const available = Array.from(g.__recoConfigs!.keys()).join(', ') || '(none registered)';
    throw new Error(
      `No reco config registered with id '${id}'. Available: [${available}]. ` +
      `If empty, the configs.ts module did not execute — check imports.`
    );
  }
  return c;
}

export function listConfigs(): ReconcileConfig[] {
  return Array.from(g.__recoConfigs!.values());
}
