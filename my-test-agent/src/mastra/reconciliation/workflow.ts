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
import { openRecoRun, writeRecoDecisions } from './tools.js';
import { runMatchGraph } from './matcher.js';

const NormalizedTxnArray = z.array(NormalizedTxnSchema);
const Unknowns = z.array(z.unknown());

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
    fuzzyAuto: z.number(),
    pendingHumanReview: z.number(),
    noMatchFound: z.number(),
    writtenOff: z.number(),
    flagged: z.number(),
  }),
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

const fetchedShape = z.object({ adapterId: z.string(), txns: NormalizedTxnArray });

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
    alreadyCompleted: z.boolean(),
    fetched: z.array(fetchedShape),
  }),
  execute: async ({ inputData }) => {
    const { configId, date, runId, alreadyCompleted } = inputData;
    if (alreadyCompleted) {
      return { configId, runId, alreadyCompleted, fetched: [] };
    }
    const config = getConfig(configId);
    const fetched = await Promise.all(
      config.sources.map(async s => {
        const adapter = getAdapter(s.adapterId);
        if (!adapter.fetch) {
          throw new Error(`Adapter '${s.adapterId}' has no fetch() — only parseFile(). Use the upload route instead.`);
        }
        const txns = await adapter.fetch({ date, accountId: s.accountId, options: s.options });
        return { adapterId: s.adapterId, txns };
      })
    );
    console.log(
      `[reco] Fetched ${fetched.length} sources: ` +
      fetched.map(f => `${f.adapterId}=${f.txns.length}`).join(', ')
    );
    return { configId, runId, alreadyCompleted, fetched };
  },
});

// ─── Step 3: deterministic matching (walks the match graph) ──────────────────

const deterministicMatchStep = createStep({
  id: 'deterministic-match',
  description: 'Walks config.matches; emits exact decisions + residual for fuzzy.',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
    fetched: z.array(fetchedShape),
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
    exactDecisions: Unknowns,
    unmatched: NormalizedTxnArray,
    candidatePool: NormalizedTxnArray,
  }),
  execute: async ({ inputData }) => {
    const { configId, runId, alreadyCompleted, fetched } = inputData;
    if (alreadyCompleted) {
      return { configId, runId, alreadyCompleted, exactDecisions: [], unmatched: [], candidatePool: [] };
    }
    const config = getConfig(configId);
    const result = runMatchGraph(config, fetched);
    console.log(
      `[reco] Deterministic: exact=${result.exactDecisions.length}, unmatched=${result.unmatched.length}`
    );
    return {
      configId, runId, alreadyCompleted,
      exactDecisions: result.exactDecisions,
      unmatched: result.unmatched,
      candidatePool: result.candidatePool,
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
    alreadyCompleted: z.boolean(),
    exactDecisions: Unknowns,
    unmatched: NormalizedTxnArray,
    candidatePool: NormalizedTxnArray,
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
    exactDecisions: Unknowns,
    fuzzyResults: Unknowns,
    // Original unmatched txns — same order as fuzzyResults. Passed through so
    // the disposition step can see the source txn (needed for fraud detection).
    unmatchedTxns: NormalizedTxnArray,
  }),
  execute: async ({ inputData, mastra }) => {
    const { configId, runId, alreadyCompleted, exactDecisions, unmatched, candidatePool } = inputData;
    if (alreadyCompleted || unmatched.length === 0) {
      return { configId, runId, alreadyCompleted, exactDecisions, fuzzyResults: [], unmatchedTxns: [] };
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
            JSON.stringify(u, null, 2),
            '',
            'Candidate pool (transactions from OTHER sources):',
            JSON.stringify(pool.slice(0, 20), null, 2),
            '',
            'Pick the best candidate (or null if none plausible).',
          ].join('\n');
          const result = await agent.generate(prompt, {
            structuredOutput: { schema: FuzzyMatchResultSchema },
          });
          const fr = (result as unknown as { object: FuzzyMatchResult }).object;
          return { ...fr, unmatchedSourceId: u.sourceId };
        })
      );
      fuzzyResults.push(...settled);
    }

    console.log(`[reco] Fuzzy ran on ${unmatched.length} txns (parallel × ${CONCURRENCY})`);
    return { configId, runId, alreadyCompleted, exactDecisions, fuzzyResults, unmatchedTxns: unmatched };
  },
});

// ─── Step 5: disposition decision per fuzzy result (LLM) ─────────────────────

const dispositionStep = createStep({
  id: 'disposition',
  description: 'For each fuzzy result, decide auto_match / human_review / write_off / flag_fraud (parallel).',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
    exactDecisions: Unknowns,
    fuzzyResults: Unknowns,
    unmatchedTxns: NormalizedTxnArray,
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
    allDecisions: Unknowns,
    humanReviewCases: Unknowns,
    noMatchCount: z.number(),
  }),
  execute: async ({ inputData, mastra }) => {
    const { configId, runId, alreadyCompleted, exactDecisions } = inputData;
    const fuzzyResults = inputData.fuzzyResults as FuzzyMatchResult[];
    const unmatchedTxns = inputData.unmatchedTxns as NormalizedTxn[];
    const allDecisions: RecoDecision[] = [...(exactDecisions as RecoDecision[])];
    const humanReviewCases: { sourceTxnId: string; disposition: Disposition }[] = [];
    let noMatchCount = 0;

    if (alreadyCompleted || fuzzyResults.length === 0) {
      return { configId, runId, alreadyCompleted, allDecisions, humanReviewCases, noMatchCount: 0 };
    }
    const agent = mastra?.getAgent('dispositionAgent');
    if (!agent) throw new Error('dispositionAgent not found');

    // Build a lookup so we can hand the disposition agent the original txn
    // (it needs amount/counterparty/UTR to detect fraud signals — those don't
    // appear in the FuzzyMatchResult alone).
    const txnById = new Map(unmatchedTxns.map(t => [t.sourceId, t]));

    const CONCURRENCY = 8;
    const dispositions: { fr: FuzzyMatchResult; disp: Disposition }[] = [];
    for (let i = 0; i < fuzzyResults.length; i += CONCURRENCY) {
      const batch = fuzzyResults.slice(i, i + CONCURRENCY);
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
            JSON.stringify(sourceTxn ?? null, null, 2),
            '',
            'Fuzzy match result:',
            JSON.stringify(fr, null, 2),
            '',
            'Decide the disposition by walking the matrix top-to-bottom and stopping at the first rule that fires.',
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
            reasoning: disp.reasoning,
            matcherVersion: 'v2.0.0',
          });
          break;
      }
    }

    console.log(
      `[reco] Disposition: total=${allDecisions.length}, humanReview=${humanReviewCases.length}, noMatch=${noMatchCount}`
    );
    return { configId, runId, alreadyCompleted, allDecisions, humanReviewCases, noMatchCount };
  },
});

// ─── Step 6: review gate (suspend() in prod — logging-only here) ─────────────

const reviewGateStep = createStep({
  id: 'review-gate',
  description: 'Surfaces human-review cases for the ops dashboard (suspend() integration: TODO).',
  inputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
    allDecisions: Unknowns,
    humanReviewCases: Unknowns,
    noMatchCount: z.number(),
  }),
  outputSchema: z.object({
    configId: z.string(),
    runId: z.string(),
    alreadyCompleted: z.boolean(),
    decisions: Unknowns,
    pendingReview: z.number(),
    noMatchCount: z.number(),
  }),
  execute: async ({ inputData }) => {
    const { configId, runId, alreadyCompleted, allDecisions, humanReviewCases, noMatchCount } = inputData;
    if (humanReviewCases.length > 0) {
      console.log(`[reco] ${humanReviewCases.length} cases pending human review — would suspend() in prod.`);
    }
    return {
      configId, runId, alreadyCompleted,
      decisions: allDecisions,
      pendingReview: humanReviewCases.length,
      noMatchCount,
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
    alreadyCompleted: z.boolean(),
    decisions: Unknowns,
    pendingReview: z.number(),
    noMatchCount: z.number(),
  }),
  outputSchema: OutputSchema,
  execute: async ({ inputData }) => {
    const { configId, runId, alreadyCompleted, decisions, pendingReview, noMatchCount } = inputData;
    if (alreadyCompleted) {
      console.log(`[reco] Run ${runId} already completed — skipping write`);
      return {
        configId, runId,
        totals: { exact: 0, fuzzyAuto: 0, pendingHumanReview: 0, noMatchFound: 0, writtenOff: 0, flagged: 0 },
        skipped: true,
      };
    }

    const decisionsCast = decisions as RecoDecision[];
    await writeRecoDecisions({ runId, decisions: decisionsCast });

    const totals = {
      exact: decisionsCast.filter(d => d.matchType === 'exact').length,
      fuzzyAuto: decisionsCast.filter(d => d.matchType === 'fuzzy_auto').length,
      pendingHumanReview: pendingReview,
      noMatchFound: noMatchCount,
      writtenOff: decisionsCast.filter(d => d.matchType === 'written_off').length,
      flagged: decisionsCast.filter(d => d.matchType === 'flagged_fraud').length,
    };
    console.log(`[reco] Run ${runId} complete:`, totals);
    return { configId, runId, totals, skipped: false };
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
  .then(writeDecisionsStep);

reconcileWorkflow.commit();
