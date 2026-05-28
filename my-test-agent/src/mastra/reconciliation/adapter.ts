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

/**
 * Available single-field join keys. Extended in Phase 1 for the UPI composite
 * key use case where (UTR, amount, payerVpa) together disambiguate.
 */
export type JoinKeyField =
  | 'merchantRefId'
  | 'utr'
  | 'sourceId'
  | 'settlementId'
  | 'pyId'
  | 'payerVpa'
  | 'amountPaise'
  | 'date';

/**
 * A join key may be a single field OR a composite of several fields, in which
 * case ALL named fields must be equal (after transforms) for a match to fire.
 * Composite keys solve the NPCI RRN collision problem for UPI: the UTR alone
 * is not unique across PG partners, so we key on (utr, amountPaise, payerVpa).
 */
export type JoinKey = JoinKeyField | { composite: JoinKeyField[] };

/**
 * Pre-comparison transforms applied to a join-key field on BOTH sides before
 * equality check. Borrowed from EndClose's filter DSL. Solves a family of
 * common data-hygiene bugs at the match layer rather than the adapter layer.
 *
 *   digits_only       — strip non-digits ('UPI/0613...' → '0613...')
 *   lowercase         — case-insensitive comparison
 *   uppercase         — same, opposite direction
 *   alphanumeric_only — drop everything except [A-Za-z0-9]
 *   strip_whitespace  — collapse leading/trailing/internal whitespace
 *   first_n_chars:N   — keep only the first N characters (e.g. 'first_n_chars:12')
 */
export type FieldTransform =
  | 'digits_only'
  | 'lowercase'
  | 'uppercase'
  | 'alphanumeric_only'
  | 'strip_whitespace'
  | `first_n_chars:${number}`;

/**
 * Unified tolerance clause. One primitive expresses both amount tolerance AND
 * date proximity. Multiple clauses on the same MatchStrategy are AND-combined.
 * Borrowed from EndClose. Replaces the v0 single-field `tolerancePaise` option.
 *
 * Examples:
 *   { field: 'amountPaise', amount: 100,  unit: 'paise' }    — within ₹1
 *   { field: 'amountPaise', amount: 1,    unit: 'percent' }  — within 1%
 *   { field: 'date',        amount: 2,    unit: 'day' }      — within 2 days
 */
export interface ToleranceClause {
  field: 'amountPaise' | 'date';
  amount: number;
  unit: 'paise' | 'percent' | 'day' | 'month';
}

export interface MatchStrategy {
  name: string;
  /** Adapter id producing the LEFT side of the match */
  from: string;
  /** Adapter id producing the RIGHT side of the match */
  to: string;
  /** Field(s) to join on. Single field for typical cases, composite for UPI's NPCI-RRN-collision use case. */
  joinKey: JoinKey;
  /** Pre-comparison transforms applied to the joinKey field on both sides. Empty/absent = no transforms. */
  transforms?: FieldTransform[];
  /**
   * Per-field transform overrides for composite keys. Keyed by composite field
   * name (e.g. 'utr', 'payerVpa'). A field present here uses ITS list; fields
   * absent fall back to the strategy-wide `transforms`.
   *
   * WHY: a single transform list applied to every field is wrong for mixed
   * keys. `digits_only` is correct for a numeric RRN but destroys an
   * alphanumeric UPI VPA (`name@bank` → '' → the row gets disqualified). Use
   * `{ utr: ['digits_only'], payerVpa: ['lowercase','strip_whitespace'] }`.
   */
  transformsByField?: Partial<Record<string, FieldTransform[]>>;
  /**
   * 'exact'              — 1:1 join on joinKey, amounts must be equal
   * 'amount_tolerance'   — 1:1 join, amounts within tolerancePaise (legacy form)
   * 'tolerance'          — 1:1 join, generalised tolerance clauses (preferred for new configs)
   * 'sum_then_match'     — group LEFT by aggregateBy, sum, then match to RIGHT amount
   * 'exclude_if_present' — anti-join: drops LEFT rows that have a counterpart in RIGHT
   *                         (e.g. exclude Consolidated already-settled rows). No amount check.
   */
  strategy: 'exact' | 'amount_tolerance' | 'tolerance' | 'sum_then_match' | 'exclude_if_present';
  /** For 'sum_then_match' — which field on LEFT defines the aggregation group */
  aggregateBy?: 'settlementId';
  /** Allowed amount delta in paise. Default 0 for 'exact'. LEGACY — use `tolerance[]` for new configs. */
  tolerancePaise?: number;
  /** Generalised tolerance clauses (replaces tolerancePaise). All clauses AND-combined. */
  tolerance?: ToleranceClause[];
  /**
   * For marketplace reco: function predicting expected NET payout from a
   * source row's gross amount. Useful when the bank credit ≠ raw sum because
   * commission/tax/TCS was deducted by the platform.
   */
  expectedNetPaise?: (gross: number, txn: NormalizedTxn) => number;
  /** Optional explicit rule id surfaced on every emitted decision. Defaults to `name`. */
  ruleId?: string;
}

/**
 * A leg is an ordered group of match strategies that share a logical purpose
 * (e.g. "consolidate PG MIS against PG Incoming"). Legs run in array order;
 * unmatched rows from leg N flow into leg N+1's pool. Optional — configs
 * without `legs[]` are treated as a single implicit leg from `matches[]`.
 */
export interface ReconcileLeg {
  id: string;
  name: string;
  description?: string;
  /** AdapterIds providing input to this leg (in addition to carried-forward rows). */
  inputs?: string[];
  matches: MatchStrategy[];
  outputs?: {
    carryForward: 'matched' | 'unmatched' | 'all';
    asSource: string;
  };
}

export interface ReconcileConfig {
  /** Stable id used to invoke a specific reco from the workflow */
  id: string;
  name: string;
  description: string;
  /** Adapters to fetch from at the start of the run */
  sources: {
    adapterId: string;
    accountId?: string;
    options?: Record<string, unknown>;
    /**
     * When true, the workflow's fetch step accepts zero rows from this adapter
     * without failing. Use for cross-check adapters that legitimately return
     * empty in v1 (e.g. `internal-pg-db` stub when RECO_INTERNAL_PG_DB_URL is
     * not configured). Default false — most sources MUST produce data to be
     * useful.
     */
    optional?: boolean;
  }[];
  /** Ordered match steps. Each runs against the accumulated data. Used when legs[] is absent. */
  matches: MatchStrategy[];
  /**
   * Optional multi-leg orchestration. If present, the workflow runs each leg
   * in order and pipes carry-forward rows into the next leg's pool. If absent,
   * the flat `matches[]` is treated as one implicit leg (backwards-compat).
   */
  legs?: ReconcileLeg[];
  /**
   * Gate LLM use for this config. 'off' means deterministic-only — fuzzy match
   * and LLM disposition steps are skipped. Settlement workflows default to 'off'.
   * 'narration_only' allows the optional post-run exception-narration enhancer.
   * 'on' (default) preserves today's full LLM behaviour for non-settlement configs.
   */
  llm?: 'off' | 'narration_only' | 'on';
  /**
   * Optional per-record SLA. Data-model only in v1; alert pipeline deferred.
   * Lets refund/dispute workflows declare "this should be reconciled within N days".
   */
  expected_resolution_days?: number;
  /**
   * Which Mastra workflow runs this config. Lets the caller (OpenArc) route
   * without hardcoding: deterministic settlement configs use 'settlement-recon'
   * (no LLM, no review gate); everything else defaults to 'reconcile-workflow'
   * (LLM fuzzy + disposition + suspend/resume review). Surfaced via
   * /integration/info so OpenArc starts the right workflow per config.
   */
  workflow?: 'settlement-recon' | 'reconcile-workflow';
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
