/**
 * Statement Reconciliation Workflow — config-driven (multi-platform).
 *
 * Inputs: { configId: string, date: 'YYYY-MM-DD' }
 *
 * The workflow:
 *   1. Resolves the ReconcileConfig by id from the registry.
 *   2. Fetches every source declared in config.sources (in parallel).
 *   3. Walks config.matches — each strategy emits exact decisions and
 *      consumes rows from both sides.
 *   4. Anything still unmatched goes to fuzzy + disposition LLM agents.
 *   5. Cases marked human_review are surfaced for the ops dashboard (suspend()
 *      integration TODO).
 *   6. All decisions persisted to the audit table.
 *   7. Returns totals.
 *
 * Adding a new platform (Zomato, Amazon, GST, etc.):
 *   1. New file in adapters/
 *   2. Register both the adapter and a ReconcileConfig in configs.ts
 *   3. Run this workflow with the new configId. No workflow edits.
 *
 * Run from Studio:
 *   reconcileWorkflow input examples:
 *     { "configId": "bank-pg-internal", "date": "2026-05-13" }
 *     { "configId": "restaurant-swiggy", "date": "2026-05-13" }
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { scoreFuzzyCall } from './evals/runtime-scoring.js';

import { RECO_CONFIGS_LOADED, ensureConfigsRegistered } from './configs.js';
import { getConfig, getAdapter } from './adapter.js';
// Reference the sentinel so it's not stripped by aggressive dead-code elimination
void RECO_CONFIGS_LOADED;
import {
  NormalizedTxnSchema,
  type NormalizedTxn,
  type RecoDecision,
  FuzzyMatchResultSchema,
  type FuzzyMatchResult,
  DispositionSchema,
  type Disposition,
} from './types.js';
import { openRecoRun, writeRecoDecisions, getStagedTransactions, stageTransactions, getRecoRun } from './tools.js';
import { runMatchGraph } from './matcher.js';
import { runLegs } from './legs.js';
import { loadConfigRules } from './rules/loader.js';
import { getDispositionRules, applyDispositionRules, selectAutoRefundCandidateRrns } from './disposition/engine.js';
import { iterReportPackFiles, summarizeReportPack, type ReportPackWarning } from './reports/report-pack-builder.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from 'node:path';

const NormalizedTxnArray = z.array(NormalizedTxnSchema);
const Unknowns = z.array(z.unknown());

// ─── LLM-prompt helpers ──────────────────────────────────────────────────────

/**
 * Format paise as an Indian-numbering rupee string ("₹1,46,233.00").
 * Local copy intentional — keeps workflow.ts self-contained so the prompt
 * code is readable without jumping to matcher.ts.
 */
function formatRupees(paise: number): string {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return '—';
  const sign = paise < 0 ? '-' : '';
  const rupees = Math.abs(paise) / 100;
  return `${sign}₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Prepare a NormalizedTxn for an LLM prompt.
 *
 * Why: GPT routinely reads `amountPaise: 146233` and writes "₹1,46,233" in
 * its reasoning — it doesn't reliably divide by 100 to express the value in
 * rupees, especially in Indian-numbering format. Same trap for amount deltas.
 *
 * Fix: pre-compute a `displayAmount` field on every txn and TELL the agent
 * (via its instructions) to quote `displayAmount` in narration. `amountPaise`
 * stays present because the disposition matrix uses it directly
 * (`paise % 100000 === 0` for round-number fraud detection).
 */
function txnForLlm<T extends { amountPaise?: number } | null | undefined>(t: T): T extends null | undefined ? null : T & { displayAmount: string } {
  if (!t) return null as never;
  return {
    ...t,
    displayAmount: formatRupees(t.amountPaise ?? 0),
  } as never;
}

const InputSchema = z.object({
  configId: z.string().describe("Reco config id, e.g. 'bank-pg-internal' or 'restaurant-swiggy'"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  runId: z.string().optional(),
});

const OutputSchema = z.object({
  configId: z.string(),
  runId: z.string(),
  totals: z.object({
    exact: z.number(),
    toleranceMatch: z.number(),
    batchMatch: z.number(),
    fuzzyAuto: z.number(),
    /** Approved by a human reviewer on resume. */
    fuzzyHuman: z.number(),
    pendingHumanReview: z.number(),
    noMatchFound: z.number(),
    writtenOff: z.number(),
    flagged: z.number(),
  }),
  /**
   * Report pack metadata — populated after buildReportPackStep runs.
   * `available: false` when the run was skipped (alreadyCompleted) or when
   * the pack couldn't be written (errors are non-fatal — we log and continue).
   */
  reportPack: z.object({
    available: z.boolean(),
    rootDir: z.string().optional(),
    fileCount: z.number().optional(),
    summary: z.string().optional(),
  }).default({ available: false }),
  skipped: z.boolean().default(false),
});

// ─── Step 1: open / replay idempotent run ────────────────────────────────────

const openRunStep = createStep({
  id: 'open-reco-run',
  description: 'Creates or reuses a reco run row keyed on (config, date).',
  inputSchema: InputSchema,
  outputSchema: z.object({
    configId: z.string(),
    date: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    // Defensive: in case bundler stripped the top-level configs.ts execution,
    // make sure adapters + configs are registered before we look them up.
    ensureConfigsRegistered();
    const { configId, date, runId } = inputData;
    const result = await openRecoRun({ date, source: configId, runId });
    return { configId, date, runId: result.runId, alreadyCompleted: result.alreadyCompleted };
  },
});

// ─── Step 2: fetch every source declared in the config ───────────────────────

// IMPORTANT: this step intentionally returns ONLY a manifest (counts), not the
// txns themselves. Mastra serializes every step output into
// mastra_workflow_snapshot via JSON.stringify; passing 100k+ NormalizedTxn rows
// between steps blows past V8's max string length (~512MB) at v1 scale.
// Downstream steps re-read from the staging table on demand instead.
const sourceSummaryShape = z.object({
  adapterId: z.string(),
  txnCount: z.number().int().nonnegative(),
  origin: z.enum(['staged', 'fetched', 'empty']),
});

const fetchAllSourcesStep = createStep({
  id: 'fetch-all-sources',
  description: "Fetches every source listed in the config in parallel.",
  inputSchema: z.object({
    configId: z.string(),
    date: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    // Manifest only — adapters + counts. Bulk rows are re-read from staging
    // by deterministicMatchStep. See note above on snapshot size.
    sourceSummary: z.array(sourceSummaryShape),
  }),
  execute: async ({ inputData }) => {
    const { configId, date, runId, alreadyCompleted } = inputData;
    if (alreadyCompleted) {
      return { configId, runId, date, alreadyCompleted, sourceSummary: [] };
    }
    const config = getConfig(configId);

    // For each source: staging first; if empty, optional real-API fetch();
    // if neither yields rows, fail the whole run with a precise error so the
    // operator knows exactly which source needs an upload.
    const sourceSummary: { adapterId: string; txnCount: number; origin: 'staged' | 'fetched' | 'empty' }[] = [];
    const missing: string[] = [];

    for (const s of config.sources) {
      const adapter = getAdapter(s.adapterId);

      // 1) Staging — load just for counting + the API-fetch fallback decision.
      //    We drop the array as soon as we know how many rows there are; the
      //    actual data flows through staging, not through the workflow context.
      let txns = await getStagedTransactions(configId, s.adapterId, date);
      let origin: 'staged' | 'fetched' | 'empty' = txns.length > 0 ? 'staged' : 'empty';

      // 2) Fallback to real API if the adapter implements one. Adapters whose
      //    upstream has no public API (banks, marketplaces, ERP) deliberately
      //    don't implement fetch() — they're upload-only.
      if (txns.length === 0 && adapter.fetch) {
        try {
          txns = await adapter.fetch({ date, accountId: s.accountId, options: s.options });
          origin = txns.length > 0 ? 'fetched' : 'empty';
          // Materialize the fetched rows into staging so the run is replayable
          // and so downstream tooling sees a single source of truth.
          if (txns.length > 0) {
            await stageTransactions({
              configId, adapterId: s.adapterId, date, txns,
              filename: `[api-fetch:${s.adapterId}]`,
            });
          }
        } catch (e) {
          // Surface fetch errors but keep going — the missing[] list collects
          // every gap before we throw, so the operator sees the full picture.
          console.warn(`[reco] adapter.fetch('${s.adapterId}') failed: ${(e as Error).message}`);
        }
      }

      const txnCount = txns.length;
      // Free the array immediately so we don't hold ~70MB across the rest of
      // the workflow context. Staging is the durable source of truth.
      txns = [];

      console.log(`[reco] source ${s.adapterId}: ${txnCount} txns (${origin})${s.optional ? ' [optional]' : ''}`);

      if (txnCount === 0 && !s.optional) {
        missing.push(s.adapterId);
      }
      sourceSummary.push({ adapterId: s.adapterId, txnCount, origin });
    }

    if (missing.length > 0) {
      throw new Error(
        `Cannot start reconciliation: no data available for source(s) [${missing.join(', ')}] ` +
        `under config '${configId}' for date ${date}. ` +
        `Upload the missing statement(s) via POST /reco/upload, or configure the corresponding ` +
        `real-API credentials (see adapter source code for required env vars).`
      );
    }

    console.log(
      `[reco] Fetched ${sourceSummary.length} sources: ` +
      sourceSummary.map(s => `${s.adapterId}=${s.txnCount}`).join(', ')
    );
    return { configId, runId, date, alreadyCompleted, sourceSummary };
  },
});

// ─── Step 3: deterministic matching (walks the match graph) ──────────────────

const TotalsShape = z.object({
  exact: z.number(),
  toleranceMatch: z.number(),
  batchMatch: z.number(),
  fuzzyAuto: z.number(),
  fuzzyHuman: z.number(),
  pendingHumanReview: z.number(),
  noMatchFound: z.number(),
  writtenOff: z.number(),
  flagged: z.number(),
});

const deterministicMatchStep = createStep({
  id: 'deterministic-match',
  description: 'Walks config.matches; emits exact decisions + residual for fuzzy.',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    sourceSummary: z.array(sourceSummaryShape),
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    // For LLM configs (llm !== 'off'), these carry the rows downstream to
    // fuzzy/disposition. For settlement (llm === 'off') they stay EMPTY —
    // decisions get persisted to DB inside this step and downstream steps
    // short-circuit on `decisionsPersisted`.
    exactDecisions: Unknowns,
    unmatched: Unknowns,
    candidatePool: Unknowns,
    /** When true, decisions are already in reco_decisions; downstream steps
     *  must NOT re-write or re-process them. Set for llm='off' settlement
     *  configs to keep the workflow snapshot tiny. */
    decisionsPersisted: z.boolean().default(false),
    /** Pre-computed totals (only populated when decisionsPersisted=true). */
    totals: TotalsShape.optional(),
  }),
  execute: async ({ inputData }) => {
    const { configId, runId, date, alreadyCompleted, sourceSummary } = inputData;
    if (alreadyCompleted) {
      return {
        configId, runId, date, alreadyCompleted,
        exactDecisions: [], unmatched: [], candidatePool: [],
        decisionsPersisted: false,
      };
    }
    const config = getConfig(configId);
    const stepT0 = process.hrtime.bigint();

    // Re-read every source from staging. The workflow's previous step
    // intentionally dropped these arrays so the workflow snapshot doesn't
    // exceed V8's max string length. The matcher needs them in-memory.
    const fetchT0 = process.hrtime.bigint();
    const fetched: { adapterId: string; txns: NormalizedTxn[] }[] = [];
    for (const s of sourceSummary) {
      const txns = await getStagedTransactions(configId, s.adapterId, date);
      fetched.push({ adapterId: s.adapterId, txns });
    }
    const fetchMs = Number(process.hrtime.bigint() - fetchT0) / 1_000_000;
    const totalRows = fetched.reduce((sum, f) => sum + f.txns.length, 0);
    console.log(
      `[reco] Deterministic step starting — config=${configId} ` +
      `sources=${fetched.length} totalRows=${totalRows} ` +
      `${fetched.map(f => `${f.adapterId}=${f.txns.length}`).join(' ')} ` +
      `(staging reload in ${fetchMs.toFixed(0)}ms)`,
    );

    // Multi-leg configs (e.g. settlement-yes-pg) go through the leg runner.
    // Single-flat-matches configs go through the legacy runMatchGraph for
    // byte-identical behaviour. The leg runner uses the same primitives
    // (runMatchesOnPool) so output shape is identical.
    const matchT0 = process.hrtime.bigint();
    const result = config.legs && config.legs.length > 0
      ? runLegs(config, fetched)
      : runMatchGraph(config, fetched);
    const matchMs = Number(process.hrtime.bigint() - matchT0) / 1_000_000;
    console.log(
      `[reco] Deterministic match (${config.legs ? `${config.legs.length}-leg` : 'flat'}) ` +
      `done in ${matchMs.toFixed(0)}ms: decisions=${result.exactDecisions.length}, unmatched=${result.unmatched.length}`,
    );

    // Pure-rule disposition: if a rule set is registered for this config AND
    // the config opts out of LLM (settlement default), evaluate per-MIS-row
    // SOP scenarios and emit ONE summary decision per anchor (MIS) row carrying
    // the final bucket + cross-file status snapshot.
    let allDecisions: RecoDecision[] = result.exactDecisions;
    let summaries: RecoDecision[] = [];
    const dispo = getDispositionRules(configId);
    if (dispo && config.llm === 'off') {
      // ── Auto-refund lookup-by-RRN ───────────────────────────────────────
      // Find the "Success in MIS but missing everywhere" RRNs from the leg
      // results, query open_prod for ONLY those RRNs, and append the refund
      // records as a synthetic source the disposition engine can read.
      let fetchedForDispo = fetched;
      if (dispo.apply.refundsAdapterId && dispo.apply.autoRefundCandidate) {
        const candidateRrns = selectAutoRefundCandidateRrns({
          fetched,
          decisions: result.exactDecisions,
          config: dispo.apply,
        });
        if (candidateRrns.length > 0) {
          const refundT0 = process.hrtime.bigint();
          try {
            const refundAdapter = getAdapter(dispo.apply.refundsAdapterId);
            const refundRows = refundAdapter.fetch
              ? await refundAdapter.fetch({ date, options: { candidates: candidateRrns } })
              : [];
            fetchedForDispo = [...fetched, { adapterId: dispo.apply.refundsAdapterId, txns: refundRows }];
            const refundMs = Number(process.hrtime.bigint() - refundT0) / 1_000_000;
            console.log(
              `[reco] Auto-refund lookup: ${candidateRrns.length} missing-success RRN(s) → ` +
              `${refundRows.length} refund record(s) in ${refundMs.toFixed(0)}ms`,
            );
          } catch (e) {
            console.warn(
              `[reco] Auto-refund lookup failed: ${(e as Error).message}. ` +
              `Candidates route to 'Not Settled (Checking Internally)'.`,
            );
          }
        } else {
          console.log(`[reco] Auto-refund lookup: no missing-success candidates to check.`);
        }
      }

      const dispoT0 = process.hrtime.bigint();
      summaries = applyDispositionRules({
        fetched: fetchedForDispo,
        decisions: result.exactDecisions,
        rules: dispo.rules,
        config: dispo.apply,
      });
      const dispoMs = Number(process.hrtime.bigint() - dispoT0) / 1_000_000;
      const byBucket = new Map<string, number>();
      for (const s of summaries) {
        const b = s.metadata?.disposition?.bucket ?? 'no_disposition';
        byBucket.set(b, (byBucket.get(b) ?? 0) + 1);
      }
      const bucketSummary = Array.from(byBucket.entries())
        .map(([b, n]) => `${b}=${n}`).join(', ');
      console.log(
        `[reco] Disposition (${dispo.rules.length} rules) done in ${dispoMs.toFixed(0)}ms: ` +
        `${summaries.length} summary decisions; ${bucketSummary}`,
      );
    }

    // ─── llm='off' path: persist + emit small payload ─────────────────────
    //
    // MIS-anchored persistence (settlement): when a disposition rule set is
    // registered, the per-MIS-row SUMMARIES are the canonical record — one row
    // per MIS txn carrying its final bucket + status snapshot. The settlement
    // and exception reports build entirely from these. We do NOT persist the
    // leg-level decisions or the ~100k non-MIS unmatched rows: they're
    // intermediate, finance never sees them, and persisting 145k rows was the
    // bottleneck. Persisting ~18k summaries is ~8x lighter.
    //
    // Fallback (no disposition rules): keep the legacy behaviour — persist leg
    // decisions plus an exception bucket for the residual.
    if (config.llm === 'off') {
      let toPersist: RecoDecision[];
      if (summaries.length > 0) {
        toPersist = summaries;
      } else {
        for (const t of result.unmatched) {
          allDecisions.push({
            sourceTxnId: t.sourceId,
            targetTxnId: null,
            matchType: 'unmatched',
            amountDeltaPaise: 0,
            decidedBy: 'system',
            matcherVersion: 'v2.2.0',
            reasoning: 'No deterministic rule matched — routed to exception report for human review.',
            metadata: {
              strategyName: 'exception_bucket',
              ruleId: 'no_deterministic_match',
              ruleSource: 'default',
              auditReasoning: 'config.llm=off; all unmatched residual goes to exception bucket without LLM.',
            },
          });
        }
        toPersist = allDecisions;
      }

      const persistT0 = process.hrtime.bigint();
      await writeRecoDecisions({ runId, decisions: toPersist, markCompleted: false });
      const persistMs = Number(process.hrtime.bigint() - persistT0) / 1_000_000;

      const totals = {
        exact: toPersist.filter(d => d.matchType === 'exact').length,
        toleranceMatch: toPersist.filter(d => d.matchType === 'tolerance_match').length,
        batchMatch: toPersist.filter(d => d.matchType === 'batch_match').length,
        fuzzyAuto: toPersist.filter(d => d.matchType === 'fuzzy_auto').length,
        fuzzyHuman: toPersist.filter(d => d.matchType === 'fuzzy_human').length,
        pendingHumanReview: 0,
        noMatchFound: toPersist.filter(d => d.matchType === 'unmatched').length,
        writtenOff: toPersist.filter(d => d.matchType === 'written_off').length,
        flagged: toPersist.filter(d => d.matchType === 'flagged_fraud').length,
      };

      const stepMs = Number(process.hrtime.bigint() - stepT0) / 1_000_000;
      const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(
        `[reco] Deterministic step total: ${stepMs.toFixed(0)}ms, ` +
        `${toPersist.length} decisions persisted in ${persistMs.toFixed(0)}ms, heap=${memMb}MB`,
      );

      // Return ONLY the small payload — empty arrays so the workflow snapshot
      // stays under V8's string-length limit. Downstream steps see
      // decisionsPersisted=true and skip their work.
      return {
        configId, runId, date, alreadyCompleted,
        exactDecisions: [], unmatched: [], candidatePool: [],
        decisionsPersisted: true,
        totals,
      };
    }

    // ─── llm='on' path: legacy behaviour, pass arrays to fuzzy/disposition ─
    // (Volumes here are small — Razorpay/Cashfree/Swiggy configs — so the
    // workflow snapshot stays well under V8 limits.)
    const stepMs = Number(process.hrtime.bigint() - stepT0) / 1_000_000;
    const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(
      `[reco] Deterministic step total: ${stepMs.toFixed(0)}ms, ` +
      `${allDecisions.length} decisions emitted, heap=${memMb}MB`,
    );

    return {
      configId, runId, date, alreadyCompleted,
      exactDecisions: allDecisions,
      unmatched: result.unmatched,
      candidatePool: result.candidatePool,
      decisionsPersisted: false,
    };
  },
});

// ─── Step 4: fuzzy-match each residual (LLM) ─────────────────────────────────

const fuzzyMatchStep = createStep({
  id: 'fuzzy-match',
  description: 'LLM picks best candidate per unmatched txn (runs in parallel).',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    exactDecisions: Unknowns,
    unmatched: Unknowns,
    candidatePool: Unknowns,
    decisionsPersisted: z.boolean().default(false),
    totals: TotalsShape.optional(),
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    exactDecisions: Unknowns,
    fuzzyResults: Unknowns,
    // Original unmatched txns — same order as fuzzyResults. Passed through so
    // the disposition step can see the source txn (needed for fraud detection).
    // Unknowns (not NormalizedTxnArray) so Mastra doesn't Zod-validate 100k+
    // rows between steps — OOMs at v1 scale.
    unmatchedTxns: Unknowns,
    decisionsPersisted: z.boolean().default(false),
    totals: TotalsShape.optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    const { configId, runId, date, alreadyCompleted, exactDecisions, decisionsPersisted, totals } = inputData;
    // Short-circuit: settlement (llm='off') already persisted decisions inside
    // deterministicMatchStep; the only job left is markCompleted (handled by
    // writeDecisionsStep) and the report pack. Pass small payload through.
    if (decisionsPersisted) {
      return {
        configId, runId, date, alreadyCompleted,
        exactDecisions: [], fuzzyResults: [], unmatchedTxns: [],
        decisionsPersisted: true, totals,
      };
    }
    const unmatched = inputData.unmatched as NormalizedTxn[];
    const candidatePool = inputData.candidatePool as NormalizedTxn[];
    if (alreadyCompleted || unmatched.length === 0) {
      return {
        configId, runId, date, alreadyCompleted,
        exactDecisions, fuzzyResults: [], unmatchedTxns: [],
        decisionsPersisted: false, totals,
      };
    }
    // Principle 1 (deterministic-first): when config.llm === 'off' (settlement
    // default), skip fuzzy matching entirely. The unmatched residual flows
    // through to disposition unchanged, where it is bucketed as 'unmatched'
    // (exception) without any LLM involvement. `unmatchedTxns` carries them.
    const cfg = getConfig(configId);
    if (cfg.llm === 'off') {
      console.log(`[reco] Fuzzy step skipped (config.llm='off') — ${unmatched.length} txns will route to exception bucket`);
      return {
        configId, runId, date, alreadyCompleted,
        exactDecisions, fuzzyResults: [], unmatchedTxns: unmatched,
        decisionsPersisted: false, totals,
      };
    }
    const agent = mastra?.getAgent('fuzzyMatchAgent');
    if (!agent) throw new Error('fuzzyMatchAgent not found');

    // Parallel: huge speedup vs the previous sequential loop.
    // Cap concurrency at 8 to avoid OpenAI rate limits at high N.
    const CONCURRENCY = 8;
    const fuzzyResults: FuzzyMatchResult[] = [];
    for (let i = 0; i < unmatched.length; i += CONCURRENCY) {
      const batch = unmatched.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async u => {
          const pool = candidatePool.filter(c => c.source !== u.source && c.sourceId !== u.sourceId);
          const prompt = [
            'Unmatched transaction:',
            JSON.stringify(txnForLlm(u), null, 2),
            '',
            'Candidate pool (transactions from OTHER sources):',
            JSON.stringify(pool.slice(0, 20).map(txnForLlm), null, 2),
            '',
            'When writing rupee figures in your reasoning, ALWAYS quote the `displayAmount` field. NEVER cite `amountPaise` directly as a rupee value (it is in paise, where 100 paise = ₹1).',
            '',
            'Pick the best candidate (or null if none plausible).',
          ].join('\n');
          const result = await agent.generate(prompt, {
            structuredOutput: { schema: FuzzyMatchResultSchema },
          });
          const fr = (result as unknown as { object: FuzzyMatchResult }).object;

          // Fire live scoring. Sampled internally (RECO_SCORE_SAMPLE_RATE).
          // Not awaited — scoring must NEVER block reco completion. Errors
          // are swallowed inside the helper.
          void Promise.all(scoreFuzzyCall({ candidatePool: pool, unmatched: u, result: fr }));

          return { ...fr, unmatchedSourceId: u.sourceId };
        })
      );
      fuzzyResults.push(...settled);
    }

    console.log(`[reco] Fuzzy ran on ${unmatched.length} txns (parallel × ${CONCURRENCY})`);
    return {
      configId, runId, date, alreadyCompleted,
      exactDecisions, fuzzyResults, unmatchedTxns: unmatched,
      decisionsPersisted: false, totals,
    };
  },
});

// ─── Step 5: disposition decision per fuzzy result (LLM) ─────────────────────

const dispositionStep = createStep({
  id: 'disposition',
  description: 'For each fuzzy result, decide auto_match / human_review / write_off / flag_fraud (parallel).',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    exactDecisions: Unknowns,
    fuzzyResults: Unknowns,
    unmatchedTxns: Unknowns,
    decisionsPersisted: z.boolean().default(false),
    totals: TotalsShape.optional(),
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    allDecisions: Unknowns,
    humanReviewCases: Unknowns,
    noMatchCount: z.number(),
    decisionsPersisted: z.boolean().default(false),
    totals: TotalsShape.optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    const { configId, runId, date, alreadyCompleted, exactDecisions, decisionsPersisted, totals } = inputData;
    // Short-circuit: settlement (llm='off') already persisted decisions inside
    // deterministicMatchStep. Pass small payload through to writeDecisionsStep.
    if (decisionsPersisted) {
      return {
        configId, runId, date, alreadyCompleted,
        allDecisions: [], humanReviewCases: [], noMatchCount: 0,
        decisionsPersisted: true, totals,
      };
    }
    const fuzzyResults = inputData.fuzzyResults as FuzzyMatchResult[];
    const unmatchedTxns = inputData.unmatchedTxns as NormalizedTxn[];
    const allDecisions: RecoDecision[] = [...(exactDecisions as RecoDecision[])];
    const humanReviewCases: { sourceTxnId: string; disposition: Disposition }[] = [];
    let noMatchCount = 0;

    if (alreadyCompleted) {
      return {
        configId, runId, date, alreadyCompleted,
        allDecisions, humanReviewCases, noMatchCount: 0,
        decisionsPersisted: false, totals,
      };
    }

    // Principle 1: when config.llm === 'off' (settlement default), there are no
    // fuzzy results because fuzzyMatchStep short-circuited. We bucket every
    // residual txn as 'unmatched' (exception) deterministically. No LLM. No
    // human-review queue from disposition — the exception report IS the
    // review surface, finance team works it in Excel.
    const cfg = getConfig(configId);
    if (cfg.llm === 'off') {
      for (const t of unmatchedTxns) {
        allDecisions.push({
          sourceTxnId: t.sourceId,
          targetTxnId: null,
          matchType: 'unmatched',
          amountDeltaPaise: 0,
          decidedBy: 'system',
          matcherVersion: 'v2.2.0',
          reasoning: 'No deterministic rule matched — routed to exception report for human review.',
          metadata: {
            strategyName: 'exception_bucket',
            ruleId: 'no_deterministic_match',
            ruleSource: 'default',
            auditReasoning: 'config.llm=off; all unmatched residual goes to exception bucket without LLM.',
          },
        });
      }
      noMatchCount = unmatchedTxns.length;
      console.log(`[reco] Disposition skipped (config.llm='off') — ${noMatchCount} unmatched routed to exception report`);
      return {
        configId, runId, date, alreadyCompleted,
        allDecisions, humanReviewCases, noMatchCount,
        decisionsPersisted: false, totals,
      };
    }

    if (fuzzyResults.length === 0) {
      return {
        configId, runId, date, alreadyCompleted,
        allDecisions, humanReviewCases, noMatchCount: 0,
        decisionsPersisted: false, totals,
      };
    }
    const agent = mastra?.getAgent('dispositionAgent');
    if (!agent) throw new Error('dispositionAgent not found');

    // Build a lookup so we can hand the disposition agent the original txn
    // (it needs amount/counterparty/UTR to detect fraud signals — those don't
    // appear in the FuzzyMatchResult alone).
    const txnById = new Map(unmatchedTxns.map(t => [t.sourceId, t]));

    // ─── Confidence-graded short-circuit (Plan B#1) ─────────────────────────
    //
    // Before paying for an LLM call, check whether the fuzzy score is
    // decisive enough to bypass the disposition agent entirely:
    //
    //   - score >= AUTO_MATCH_THRESHOLD → auto-promote to fuzzy_auto
    //     We're conservative (0.95, not 0.9): the disposition agent's value
    //     is fraud-signal detection, so we only skip it when the candidate
    //     is essentially certain AND the txn shape is non-suspicious (not a
    //     refund, has a named counterparty).
    //
    //   - score < HUMAN_REVIEW_THRESHOLD AND no candidate → won't help to
    //     ask the LLM "is this a match" when it already said no; let
    //     write-off / human-review be decided by the rest of the matrix
    //     (which still depends on amount+age, so we keep the LLM here).
    //
    // We KEEP the LLM call for everything in between (0.5..0.95) and for
    // null candidates (the LLM still needs to choose between write_off,
    // human_review, and flag_fraud based on amount/age/counterparty).
    const AUTO_MATCH_THRESHOLD = 0.95;

    function isShapeSafeForAutoMatch(srcTxn: NormalizedTxn | undefined): boolean {
      if (!srcTxn) return false;
      // Refunds (negative amount) always go to human review for safety.
      if (srcTxn.amountPaise < 0) return false;
      // Named, non-blank counterparty is a positive signal.
      const cp = (srcTxn.counterparty ?? '').trim();
      if (!cp) return false;
      // Avoid auto-matching generic banking terms.
      if (/^(unknown|neft|direct|rtgs|imps|test|trf)$/i.test(cp)) return false;
      return true;
    }

    // Plan B#3: load per-config rule sheet (if any) once for the whole step.
    // Empty string when no rules/<configId>.md exists — the prompt formatter
    // handles that gracefully.
    const configRules = await loadConfigRules(configId);
    if (configRules) {
      console.log(`[reco] Disposition: loaded rule sheet for '${configId}' (${configRules.length} chars).`);
    }

    const autoMatched: { fr: FuzzyMatchResult; disp: Disposition }[] = [];
    const needsLlmDisposition: FuzzyMatchResult[] = [];
    for (const fr of fuzzyResults) {
      const candidate = fr.bestCandidate;
      const sourceTxn = txnById.get(fr.unmatchedSourceId);
      if (
        candidate
        && candidate.similarityScore >= AUTO_MATCH_THRESHOLD
        && isShapeSafeForAutoMatch(sourceTxn)
      ) {
        autoMatched.push({
          fr,
          disp: {
            sourceTxnId: fr.unmatchedSourceId,
            recommendation: 'auto_match',
            targetTxnId: candidate.candidateTxnId,
            confidence: 'high',
            reasoning:
              `confidence-graded promotion: similarityScore=${candidate.similarityScore.toFixed(2)}`
              + ` >= ${AUTO_MATCH_THRESHOLD}, non-refund, named counterparty → auto_match (no LLM dispo).`,
            reviewerExplanation: '',
          },
        });
        continue;
      }
      needsLlmDisposition.push(fr);
    }
    console.log(
      `[reco] Disposition pre-filter: ${autoMatched.length} auto-matched (score>=${AUTO_MATCH_THRESHOLD}), ` +
      `${needsLlmDisposition.length} routed to LLM.`
    );

    const CONCURRENCY = 8;
    const dispositions: { fr: FuzzyMatchResult; disp: Disposition }[] = [...autoMatched];
    for (let i = 0; i < needsLlmDisposition.length; i += CONCURRENCY) {
      const batch = needsLlmDisposition.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async fr => {
          const sourceTxn = txnById.get(fr.unmatchedSourceId);
          // Precompute daysOld so the agent doesn't have to do date math.
          // Models reliably fail at "is 2026-03-14 more than 30 days before
          // 2026-05-13" — easier to hand them a number.
          const today = new Date();
          const txnDate = sourceTxn?.date ? new Date(sourceTxn.date) : today;
          const daysOld = Math.max(0, Math.floor((today.getTime() - txnDate.getTime()) / 86_400_000));
          const prompt = [
            `Today is ${today.toISOString().slice(0, 10)}. daysOld = ${daysOld}.`,
            '',
            'Unmatched source transaction:',
            JSON.stringify(txnForLlm(sourceTxn), null, 2),
            '',
            'Fuzzy match result:',
            JSON.stringify(fr, null, 2),
            '',
            // GPT routinely confuses `amountPaise` for rupees and writes
            // "₹1,46,233" when the value is actually ₹1,462.33. Force the
            // narration to use the pre-formatted `displayAmount`.
            'When writing rupee figures in `reasoning` or `reviewerExplanation`, ALWAYS quote the `displayAmount` field. NEVER cite `amountPaise` directly as a rupee value (it is in paise, where 100 paise = ₹1).',
            '',
            'Decide the disposition by walking the matrix top-to-bottom and stopping at the first rule that fires.',
            // Per-config rule sheet (Plan B#3). Layered ON TOP of the
            // universal matrix — fraud check still runs first; these rules
            // fine-tune judgment calls for known platform quirks (fee model,
            // settlement cadence, refund patterns).
            ...(configRules
              ? ['', '## Config-specific rules', `(applies when configId='${configId}')`, '', configRules]
              : []),
          ].join('\n');
          const result = await agent.generate(prompt, {
            structuredOutput: { schema: DispositionSchema },
          });
          const disp = (result as unknown as { object: Disposition }).object;
          return { fr, disp };
        })
      );
      dispositions.push(...settled);
    }

    for (const { fr, disp } of dispositions) {
      if (!fr.bestCandidate) noMatchCount += 1;

      switch (disp.recommendation) {
        case 'auto_match':
          allDecisions.push({
            sourceTxnId: fr.unmatchedSourceId,
            targetTxnId: disp.targetTxnId,
            matchType: 'fuzzy_auto',
            amountDeltaPaise: 0,
            decidedBy: 'system',
            reasoning: disp.reasoning,
            matcherVersion: 'v2.0.0',
          });
          break;
        case 'write_off':
          allDecisions.push({
            sourceTxnId: fr.unmatchedSourceId,
            targetTxnId: null,
            matchType: 'written_off',
            amountDeltaPaise: 0,
            decidedBy: 'system',
            reasoning: disp.reasoning,
            matcherVersion: 'v2.0.0',
          });
          break;
        case 'flag_fraud':
          allDecisions.push({
            sourceTxnId: fr.unmatchedSourceId,
            targetTxnId: null,
            matchType: 'flagged_fraud',
            amountDeltaPaise: 0,
            decidedBy: 'system',
            reasoning: disp.reasoning,
            matcherVersion: 'v2.0.0',
          });
          break;
        case 'human_review':
        default:
          // Two things for human-review cases:
          // (1) Push to humanReviewCases for the suspend()/resume() target.
          // (2) ALSO persist as a 'pending_review' decision so the audit log
          //     is complete from minute zero — without this, OpenArc dashboards
          //     show an empty decisions array for any run dominated by reviews.
          humanReviewCases.push({ sourceTxnId: fr.unmatchedSourceId, disposition: disp });
          allDecisions.push({
            sourceTxnId: fr.unmatchedSourceId,
            targetTxnId: disp.targetTxnId,
            matchType: 'pending_review',
            amountDeltaPaise: 0,
            decidedBy: 'system',
            // Prefer the reviewer-facing sentence here — it's what the
            // OpenArc UI surfaces in the decisions table. The engineering
            // `reasoning` field is preserved under metadata.auditReasoning
            // for traceability without polluting the user view.
            reasoning: disp.reviewerExplanation || disp.reasoning,
            metadata: {
              auditReasoning: disp.reasoning,
              confidence: disp.confidence,
            } as Record<string, unknown>,
            matcherVersion: 'v2.0.0',
          });
          break;
      }
    }

    console.log(
      `[reco] Disposition: total=${allDecisions.length}, humanReview=${humanReviewCases.length}, noMatch=${noMatchCount}`
    );
    return {
      configId, runId, date, alreadyCompleted,
      allDecisions, humanReviewCases, noMatchCount,
      decisionsPersisted: false, totals,
    };
  },
});

// ─── Step 6: review gate (suspend/resume for human approval) ────────────────
//
// When the disposition agent flagged ≥1 case as `human_review`, this step
// SUSPENDS the workflow with a payload describing the pending pile. The
// OpenArc dashboard renders that payload, an operator approves/rejects, and
// OpenArc calls Mastra's resume API with the verdicts. The step then
// mutates each pending decision based on the verdict and falls through to
// writeDecisionsStep.
//
// When zero cases need review (or this is a no-op already-completed run),
// the step passes through without suspending.

// ─── Schemas exposed to OpenArc ──────────────────────────────────────────────

/** What a UI sees in the suspended state — minimal metadata only.
 *  The actual decision rows (with source/target amounts joined from staging)
 *  are queried by the UI via /reco/runs/:id/decisions where matchType =
 *  'pending_review'. We persist them to the audit table before suspending
 *  so that endpoint returns the right data immediately. */
const ReviewSuspendSchema = z.object({
  runId: z.string(),
  configId: z.string(),
  suspendedAt: z.string(),
  totalPending: z.number().int(),
});
export type ReviewSuspendPayload = z.infer<typeof ReviewSuspendSchema>;

/** What an operator submits via OpenArc to resume the workflow. Designed for
 *  bulk + override: in the common case ops clicks "Approve all" and we apply
 *  it across the pile, but rejections (and the per-row approve UI in the
 *  future) flow through the same shape. */
const ReviewResumeSchema = z.object({
  /** Default action for every pending decision in this run. */
  approveAll: z.boolean(),
  /** When approveAll=true: source txn ids to reject as overrides. */
  rejections: z.array(z.string()).default([]),
  /** When approveAll=false: source txn ids to approve as overrides. */
  approvals: z.array(z.string()).default([]),
  /** Audit attribution — e.g. "ops:42" for OpenArc user 42. Falls back to
   *  generic "human-reviewer" so the workflow never blocks on a missing id. */
  decidedBy: z.string().default('human-reviewer'),
});
export type ReviewResumePayload = z.infer<typeof ReviewResumeSchema>;

const reviewGateStep = createStep({
  id: 'review-gate',
  description: 'Suspends when human review is needed; applies operator decisions on resume.',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    allDecisions: Unknowns,
    humanReviewCases: Unknowns,
    noMatchCount: z.number(),
    decisionsPersisted: z.boolean().default(false),
    totals: TotalsShape.optional(),
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    decisions: Unknowns,
    pendingReview: z.number(),
    noMatchCount: z.number(),
    decisionsPersisted: z.boolean().default(false),
    totals: TotalsShape.optional(),
  }),
  suspendSchema: ReviewSuspendSchema,
  resumeSchema: ReviewResumeSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const { configId, runId, date, alreadyCompleted, allDecisions, humanReviewCases, noMatchCount, decisionsPersisted, totals } = inputData;

    // Short-circuit: settlement (llm='off') already persisted decisions inside
    // deterministicMatchStep. No human review queue for those configs.
    if (decisionsPersisted) {
      return {
        configId, runId, date, alreadyCompleted,
        decisions: [], pendingReview: 0, noMatchCount: 0,
        decisionsPersisted: true, totals,
      };
    }

    // Skip suspend for already-completed reruns — there's nothing to review.
    // Same for runs the disposition agent fully resolved.
    if (alreadyCompleted || humanReviewCases.length === 0) {
      return {
        configId, runId, date, alreadyCompleted,
        decisions: allDecisions,
        pendingReview: 0,
        noMatchCount,
        decisionsPersisted: false, totals,
      };
    }

    // First entry into this step — persist what we have so far, then pause
    // for operator input. Persisting BEFORE suspend is critical: the
    // OpenArc UI reads pending decisions via /reco/runs/:id/decisions, which
    // queries the audit table. Without this write the table is empty and
    // the operator sees nothing actionable.
    //
    // The same rows are re-written on resume after matchType mutation (DELETE
    // + INSERT inside one transaction in writeRecoDecisions), so this isn't
    // a duplicate — it's the first half of a two-phase write.
    if (!resumeData) {
      const decisionsCast = allDecisions as RecoDecision[];
      // markCompleted=false: don't flip the run to 'completed' yet; the
      // reviewer hasn't approved. dbOpenRecoRun then correctly identifies
      // this run as 'open' if the workflow is restarted mid-suspend.
      await writeRecoDecisions({ runId, decisions: decisionsCast, markCompleted: false });
      console.log(
        `[reco] Suspending run ${runId} — ${humanReviewCases.length} decisions awaiting human review ` +
        `(persisted ${decisionsCast.length} rows to audit table).`
      );
      return await suspend({
        runId,
        configId,
        suspendedAt: new Date().toISOString(),
        totalPending: humanReviewCases.length,
      });
    }

    // Resumed — apply the operator's verdicts to the pending decisions.
    // Other matchTypes (exact / batch_match / fuzzy_auto / written_off /
    // flagged_fraud) are untouched.
    const { approveAll, rejections, approvals, decidedBy } = resumeData;
    const rejectSet = new Set(rejections);
    const approveSet = new Set(approvals);
    const decisionsArr = allDecisions as Array<{ sourceTxnId: string; matchType: string; [k: string]: unknown }>;
    let approvedCount = 0;
    let rejectedCount = 0;
    const finalized = decisionsArr.map(d => {
      if (d.matchType !== 'pending_review') return d;
      const approved = approveAll ? !rejectSet.has(d.sourceTxnId) : approveSet.has(d.sourceTxnId);
      if (approved) {
        approvedCount++;
        return { ...d, matchType: 'fuzzy_human' as const, decidedBy };
      }
      rejectedCount++;
      return { ...d, matchType: 'unmatched' as const, decidedBy };
    });
    console.log(`[reco] Run ${runId} resumed — approved=${approvedCount}, rejected=${rejectedCount} by ${decidedBy}.`);

    return {
      configId, runId, date, alreadyCompleted,
      decisions: finalized,
      pendingReview: 0,  // resolved
      noMatchCount,
      decisionsPersisted: false, totals,
    };
  },
});

// ─── Step 7: write audit decisions + return totals ───────────────────────────

const writeDecisionsStep = createStep({
  id: 'write-decisions',
  description: 'Persists every decision to the reco_decisions audit table.',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    decisions: Unknowns,
    pendingReview: z.number(),
    noMatchCount: z.number(),
    decisionsPersisted: z.boolean().default(false),
    totals: TotalsShape.optional(),
  }),
  outputSchema: OutputSchema,
  execute: async ({ inputData }) => {
    const { configId, runId, alreadyCompleted, decisions, pendingReview, noMatchCount, decisionsPersisted, totals: preComputedTotals } = inputData;
    if (alreadyCompleted) {
      console.log(`[reco] Run ${runId} already completed — skipping write`);
      return {
        configId, runId,
        totals: { exact: 0, toleranceMatch: 0, batchMatch: 0, fuzzyAuto: 0, fuzzyHuman: 0, pendingHumanReview: 0, noMatchFound: 0, writtenOff: 0, flagged: 0 },
        skipped: true,
      };
    }

    // Short-circuit: settlement (llm='off') already persisted decisions inside
    // deterministicMatchStep with markCompleted=false. Flip the run to
    // 'completed' here without touching reco_decisions (which already has the
    // 45k+ rows). Use writeRecoDecisions with an empty array would DELETE the
    // existing rows — bad — so we hit the DB directly via dbMarkRunComplete-
    // equivalent: re-call openRecoRun... actually simpler, use a tiny inline
    // UPDATE. We import the libsql client lazily.
    if (decisionsPersisted) {
      const { dbMarkRunComplete } = await import('./db.js');
      await dbMarkRunComplete(runId);
      const totals = preComputedTotals ?? { exact: 0, toleranceMatch: 0, batchMatch: 0, fuzzyAuto: 0, fuzzyHuman: 0, pendingHumanReview: 0, noMatchFound: 0, writtenOff: 0, flagged: 0 };
      console.log(`[reco] Run ${runId} marked complete (decisions persisted inline):`, totals);
      return { configId, runId, totals, skipped: false };
    }

    const decisionsCast = decisions as RecoDecision[];
    await writeRecoDecisions({ runId, decisions: decisionsCast });

    // After review-gate resume, formerly-pending decisions are now either
    // fuzzy_human (approved) or unmatched (rejected). Count both so the
    // dashboard reflects what the human actually decided. `pendingReview`
    // still tracks how many *had* been pending — useful for SLAs / queue
    // dwell-time metrics, even after they've been resolved.
    const totals = {
      exact: decisionsCast.filter(d => d.matchType === 'exact').length,
      toleranceMatch: decisionsCast.filter(d => d.matchType === 'tolerance_match').length,
      batchMatch: decisionsCast.filter(d => d.matchType === 'batch_match').length,
      fuzzyAuto: decisionsCast.filter(d => d.matchType === 'fuzzy_auto').length,
      fuzzyHuman: decisionsCast.filter(d => d.matchType === 'fuzzy_human').length,
      pendingHumanReview: pendingReview,
      noMatchFound: noMatchCount + decisionsCast.filter(d => d.matchType === 'unmatched').length,
      writtenOff: decisionsCast.filter(d => d.matchType === 'written_off').length,
      flagged: decisionsCast.filter(d => d.matchType === 'flagged_fraud').length,
    };
    console.log(`[reco] Run ${runId} complete:`, totals);
    return { configId, runId, totals, skipped: false };
  },
});

// ─── Step 8: build the operator-facing report pack ───────────────────────────
//
// Self-contained: we don't trust the workflow's in-memory state for this step.
// Instead we re-query staged sources + persisted decisions from the DB and
// rebuild the pack from durable storage. That makes pack-build idempotent
// (re-running the step on the same run produces the same files byte-for-byte)
// and means we can rebuild a pack months later as long as the run is still
// in the DB — useful for audit / re-issuance scenarios.

const REPORT_PACK_ROOT = process.env.RECO_REPORT_PACK_ROOT ?? './run-reports';

const buildReportPackStep = createStep({
  id: 'build-report-pack',
  description: 'Builds the finance-team-facing report pack (per-leg CSVs, dispositions, settlement upload, exception report, audit log) and writes it to disk.',
  inputSchema: OutputSchema,
  outputSchema: OutputSchema,
  execute: async ({ inputData }) => {
    if (inputData.skipped) return inputData;
    const { configId, runId } = inputData;
    const config = getConfig(configId);
    const run = await getRecoRun(runId);
    if (!run) {
      console.warn(`[reco] buildReportPack: run ${runId} not found in DB — skipping pack.`);
      return { ...inputData, reportPack: { available: false } };
    }
    const date = run.date;

    try {
      // Re-fetch every adapter's staged rows. Bank/PG/internal sources all
      // live in the same staging table keyed by adapterId.
      const fetched: Array<{ adapterId: string; txns: NormalizedTxn[] }> = [];
      for (const src of config.sources) {
        const txns = await getStagedTransactions(configId, src.adapterId, date);
        fetched.push({ adapterId: src.adapterId, txns });
      }

      // Re-fetch persisted decisions for the run (they're already in the DB
      // by this point — writeDecisionsStep ran).
      const dbDecisions = await (await import('./tools.js')).listRecoDecisions(runId);
      const decisions: RecoDecision[] = dbDecisions.map(d => ({
        sourceTxnId: d.sourceTxnId,
        targetTxnId: d.targetTxnId,
        matchType: d.matchType,
        amountDeltaPaise: d.amountDeltaPaise,
        decidedBy: d.decidedBy,
        matcherVersion: d.matcherVersion,
        reasoning: d.reasoning,
        metadata: d.metadata,
      }));

      const warnings: ReportPackWarning[] = [];
      // TODO Phase 5+: collect zero-padding + schema-drift warnings during
      // adapter parsing and surface them here. For v1 the warnings file ships
      // empty unless an explicit upstream step adds entries.

      // Stream the two finance reports to disk one at a time.
      const packT0 = process.hrtime.bigint();
      const outDir = pathResolve(REPORT_PACK_ROOT, runId);
      // Clear any prior pack for this run so a re-run doesn't leave stale files
      // (e.g. the old 14-file layout) alongside the current 2 reports.
      rmSync(outDir, { recursive: true, force: true });
      let fileCount = 0;
      for (const f of iterReportPackFiles({ runId, configId, date, config, fetched, decisions, warnings })) {
        const full = pathJoin(outDir, f.path);
        mkdirSync(pathDirname(full), { recursive: true });
        writeFileSync(full, f.contents);
        fileCount += 1;
      }
      const summary = `Reports: ${fileCount} files, ${summarizeReportPack({ decisions })}`;
      const packMs = Number(process.hrtime.bigint() - packT0) / 1_000_000;
      const memMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(`[reco] ${summary} → ${outDir} (built in ${packMs.toFixed(0)}ms, heap=${memMb}MB)`);

      // Reports written = deliverables exist. Purge the staged source rows for
      // this run — they're parsed copies of the partner files and carry PII.
      // We keep only the run record + the reports (per finance + retention
      // policy). Re-running requires re-upload.
      //
      // Set RECO_PURGE_STAGING=false to RETAIN staged rows — useful during rule
      // tuning so you can re-run the same day without re-uploading 4 files each
      // time. Default (unset / any value other than 'false') purges, which is
      // the PII-safe production behaviour.
      if (process.env.RECO_PURGE_STAGING === 'false') {
        console.log(`[reco] Staged-row purge SKIPPED (RECO_PURGE_STAGING=false) — staging retained for re-runs. Do NOT use this in production.`);
      } else {
        try {
          const { dbPurgeStagedForRun } = await import('./db.js');
          const { deleted } = await dbPurgeStagedForRun(configId, date);
          console.log(`[reco] Purged ${deleted} staged rows for ${configId} ${date} (PII retention policy).`);
        } catch (purgeErr) {
          console.warn(`[reco] staged-row purge failed for ${configId} ${date}: ${(purgeErr as Error).message}`);
        }
      }

      return {
        ...inputData,
        reportPack: {
          available: true,
          rootDir: outDir,
          fileCount,
          summary,
        },
      };
    } catch (err) {
      // Pack build is non-fatal — the run already succeeded and decisions
      // are persisted. We log and continue so a transient FS failure doesn't
      // block run completion.
      console.warn(
        `[reco] buildReportPack failed for ${runId}: ${(err as Error).message}. ` +
        `Run output remains valid; rebuild the pack later via the HTTP endpoint.`,
      );
      return { ...inputData, reportPack: { available: false } };
    }
  },
});

// ─── Wiring ──────────────────────────────────────────────────────────────────

export const reconcileWorkflow = createWorkflow({
  id: 'reconcile-workflow',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .then(openRunStep)
  .then(fetchAllSourcesStep)
  .then(deterministicMatchStep)
  .then(fuzzyMatchStep)
  .then(dispositionStep)
  .then(reviewGateStep)
  .then(writeDecisionsStep)
  .then(buildReportPackStep);

reconcileWorkflow.commit();

// ─── Deterministic settlement workflow (no LLM, no review gate) ──────────────
//
// Money-critical settlement reconciliation runs through THIS workflow, never
// `reconcile-workflow`. The LLM steps (fuzzy match, disposition agent) and the
// suspend/resume review gate are structurally ABSENT — not flag-disabled — so
// the audit story is simply "no LLM is wired into the settlement decision path".
//
// It reuses the same steps as the LLM workflow up to the deterministic match
// (which, for llm='off' configs, runs the leg cascade + auto-refund lookup +
// rule disposition and persists per-MIS summaries inline), then finalises and
// builds the report pack. Output shape is identical (OutputSchema) so the
// report-pack step and OpenArc integration are unchanged.

const ZERO_TOTALS = {
  exact: 0, toleranceMatch: 0, batchMatch: 0, fuzzyAuto: 0, fuzzyHuman: 0,
  pendingHumanReview: 0, noMatchFound: 0, writtenOff: 0, flagged: 0,
};

const settlementFinalizeStep = createStep({
  id: 'settlement-finalize',
  description: 'Marks the run complete and returns totals. Decisions were already persisted inline by the deterministic-match step (settlement has no LLM/review gate).',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    date: z.string(),
    alreadyCompleted: z.boolean(),
    exactDecisions: Unknowns,
    unmatched: Unknowns,
    candidatePool: Unknowns,
    decisionsPersisted: z.boolean().default(false),
    totals: TotalsShape.optional(),
  }),
  outputSchema: OutputSchema,
  execute: async ({ inputData }) => {
    const { configId, runId, alreadyCompleted, decisionsPersisted, totals } = inputData;
    if (alreadyCompleted) {
      return { configId, runId, totals: ZERO_TOTALS, skipped: true };
    }
    if (!decisionsPersisted) {
      // Should never happen for a settlement (llm='off') config — the
      // deterministic-match step persists inline. Loud warning rather than a
      // silent mismatch.
      console.warn(
        `[reco] settlement-finalize: run ${runId} reached finalize with decisionsPersisted=false. ` +
        `Is config '${configId}' actually deterministic (llm:'off')? Marking complete anyway.`,
      );
    }
    const { dbMarkRunComplete } = await import('./db.js');
    await dbMarkRunComplete(runId);
    console.log(`[reco] Run ${runId} marked complete (settlement-recon):`, totals ?? ZERO_TOTALS);
    return { configId, runId, totals: totals ?? ZERO_TOTALS, skipped: false };
  },
});

export const settlementReconWorkflow = createWorkflow({
  id: 'settlement-recon',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .then(openRunStep)
  .then(fetchAllSourcesStep)
  .then(deterministicMatchStep)
  .then(settlementFinalizeStep)
  .then(buildReportPackStep);

settlementReconWorkflow.commit();
