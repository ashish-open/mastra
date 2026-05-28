/**
 * Eval runner — runs the fuzzy and disposition agents against the labeled
 * dataset and prints a scoreboard.
 *
 * Run:
 *   pnpm eval:reco
 *
 * Outputs:
 *   - per-case scores (✓/✗ with detail on misses)
 *   - aggregate by category (where do we win, where do we lose?)
 *   - 3 headline numbers: candidate-validity, disposition-accuracy, reasoning-quality
 *
 * This is the "is the agent getting better or worse?" check. Run it after any
 * prompt change. Track the headline numbers in a file/sheet over time.
 */

// Import agents directly (NOT the full mastra instance) so the eval can run
// while `pnpm dev` holds the DuckDB observability lock. Agents are
// standalone — they carry their own model config and don't need the
// orchestrator to call generate().
import { fuzzyMatchAgent, dispositionAgent } from '../agents.js';
import {
  CATEGORIES,
  FUZZY_CASES,
  DISPOSITION_CASES,
  type Category,
} from './dataset.js';
import {
  candidateValidityScorer,
  dispositionAccuracyScorer,
  reasoningQualityScorer,
} from './scorers.js';
import {
  FuzzyMatchResultSchema,
  DispositionSchema,
  type FuzzyMatchResult,
  type Disposition,
} from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format paise → "₹1,46,233.00" (Indian numbering). Mirrors workflow.ts. */
function formatRupees(paise: number | undefined | null): string {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return '—';
  const sign = paise < 0 ? '-' : '';
  const rupees = Math.abs(paise) / 100;
  return `${sign}₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Mirror of workflow.ts `txnForLlm` — ensures the eval exercises the same
 *  prompt shape as production. Adds `displayAmount` so the LLM never has to
 *  divide paise by 100 to express a rupee value. */
function txnForLlm<T extends { amountPaise?: number } | null | undefined>(t: T): T extends null | undefined ? null : T & { displayAmount: string } {
  if (!t) return null as never;
  return { ...t, displayAmount: formatRupees(t.amountPaise ?? 0) } as never;
}

interface CaseResult {
  name: string;
  category: Category;
  /** Pulled from the eval case so we can pivot the matrix. */
  configId?: string;
  passed: boolean;
  detail: string;
  reasoningScore?: number;
}

function makeCategoryReport(results: CaseResult[]) {
  const byCat = new Map<Category, { passed: number; total: number }>();
  for (const c of CATEGORIES) byCat.set(c, { passed: 0, total: 0 });
  for (const r of results) {
    const b = byCat.get(r.category)!;
    b.total += 1;
    if (r.passed) b.passed += 1;
  }
  return byCat;
}

function pct(p: number, t: number): string {
  if (t === 0) return '—';
  return `${Math.round((p / t) * 100)}% (${p}/${t})`;
}

// ─── Fuzzy matcher eval ──────────────────────────────────────────────────────

// ─── Concurrency helper ─────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(worker);
  await Promise.all(workers);
  return out;
}

async function runFuzzyEval(): Promise<{
  candidateValidity: CaseResult[];
  bestCandidatePick: CaseResult[];
  reasoning: CaseResult[];
}> {
  const agent = fuzzyMatchAgent;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`  FUZZY MATCHER  —  ${FUZZY_CASES.length} cases (parallel × 6)`);
  console.log('='.repeat(78));

  // Step 1: run all agent + scorer calls in parallel (concurrency=6)
  type Triplet = { validity: CaseResult; pick: CaseResult; reasoning: CaseResult };

  const triplets: Triplet[] = await mapWithConcurrency(FUZZY_CASES, 6, async c => {
    const prompt = [
      'Unmatched transaction:',
      JSON.stringify(txnForLlm(c.input.unmatched), null, 2),
      '',
      'Candidate pool (transactions from OTHER sources):',
      JSON.stringify(c.input.candidatePool.map(txnForLlm), null, 2),
      '',
      'When writing rupee figures in your reasoning, ALWAYS quote the `displayAmount` field. NEVER cite `amountPaise` directly as a rupee value (it is in paise, where 100 paise = ₹1).',
      '',
      'Pick the best candidate (or null if none plausible).',
    ].join('\n');

    let out: FuzzyMatchResult;
    try {
      const r = await agent.generate(prompt, {
        structuredOutput: { schema: FuzzyMatchResultSchema },
      });
      out = (r as unknown as { object: FuzzyMatchResult }).object;
    } catch (err) {
      const msg = (err as Error).message;
      const fail = { name: c.name, category: c.category, passed: false, detail: `agent error: ${msg}` };
      return { validity: fail, pick: fail, reasoning: { ...fail, reasoningScore: 0 } };
    }

    // candidate-validity + reasoning-quality run in parallel (independent calls)
    const [vRes, rScore] = await Promise.all([
      candidateValidityScorer.run({
        input: { candidatePool: c.input.candidatePool },
        output: { bestCandidate: out.bestCandidate },
      }),
      (async (): Promise<number> => {
        if (!out.bestCandidate) return 1; // null is fine, no reasoning to grade
        try {
          const rRes = await reasoningQualityScorer.run({
            input: { unmatchedTxn: c.input.unmatched, selectedCandidate: out.bestCandidate },
            output: { reasoning: out.bestCandidate.reasoning },
          });
          return Number(rRes.score) || 0;
        } catch {
          return 0;
        }
      })(),
    ]);

    const vPass = vRes.score === 1;
    const validity: CaseResult = {
      name: c.name, category: c.category, configId: c.configId, passed: vPass,
      detail: vPass ? 'ok' : `picked '${out.bestCandidate?.candidateTxnId}' not in pool`,
    };

    const expected = c.expected.candidateTxnId;
    const actual = out.bestCandidate?.candidateTxnId ?? null;
    let pickPass = expected === actual;
    if (pickPass && expected !== null && out.bestCandidate) {
      const s = out.bestCandidate.similarityScore;
      if (c.expected.minScore !== undefined && s < c.expected.minScore) pickPass = false;
      if (c.expected.maxScore !== undefined && s > c.expected.maxScore) pickPass = false;
    }
    const pick: CaseResult = {
      name: c.name, category: c.category, configId: c.configId, passed: pickPass,
      detail: pickPass
        ? `${actual ?? 'null'} ✓`
        : expected === actual
          ? `id ok (${actual}) but score=${out.bestCandidate?.similarityScore} outside [${c.expected.minScore ?? '−∞'}..${c.expected.maxScore ?? '∞'}]`
          : `expected '${expected}', got '${actual}' (score=${out.bestCandidate?.similarityScore ?? 'n/a'})`,
    };

    const reasoning: CaseResult = {
      name: c.name, category: c.category, configId: c.configId, passed: rScore >= 0.5,
      detail: `score=${rScore}`,
      reasoningScore: rScore,
    };
    return { validity, pick, reasoning };
  });

  // Print results in original order (preserving the case order)
  for (let i = 0; i < triplets.length; i++) {
    const c = FUZZY_CASES[i];
    const t = triplets[i];
    const marker = t.validity.passed && t.pick.passed && (t.reasoning.reasoningScore ?? 0) >= 0.5 ? '✓' : '✗';
    console.log(`  ${marker} [${c.category}] ${c.name}`);
    if (!t.validity.passed) console.log(`     • validity: ${t.validity.detail}`);
    if (!t.pick.passed) console.log(`     • pick:     ${t.pick.detail}`);
    if ((t.reasoning.reasoningScore ?? 0) < 0.5) console.log(`     • reasoning: ${t.reasoning.detail}`);
  }

  return {
    candidateValidity: triplets.map(t => t.validity),
    bestCandidatePick: triplets.map(t => t.pick),
    reasoning: triplets.map(t => t.reasoning),
  };
}

// ─── Disposition eval ────────────────────────────────────────────────────────

async function runDispositionEval(): Promise<{ dispositionAccuracy: CaseResult[] }> {
  const agent = dispositionAgent;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`  DISPOSITION  —  ${DISPOSITION_CASES.length} cases (parallel × 6)`);
  console.log('='.repeat(78));

  const acc = await mapWithConcurrency(DISPOSITION_CASES, 6, async c => {
    // For deterministic eval, fix "today" to the dataset's reference date.
    // This way daysOld is computed the same way every run regardless of
    // when the eval is executed.
    const evalToday = new Date('2026-05-13');
    const txnDate = c.input.sourceTxn.date ? new Date(c.input.sourceTxn.date) : evalToday;
    const daysOld = Math.max(
      0,
      Math.floor((evalToday.getTime() - txnDate.getTime()) / 86_400_000)
    );
    const prompt = [
      `Today is ${evalToday.toISOString().slice(0, 10)}. daysOld = ${daysOld}.`,
      '',
      'Unmatched source transaction:',
      JSON.stringify(txnForLlm(c.input.sourceTxn), null, 2),
      '',
      'Fuzzy match result:',
      JSON.stringify(c.input.fuzzyResult, null, 2),
      '',
      'When writing rupee figures in `reasoning` or `reviewerExplanation`, ALWAYS quote the `displayAmount` field. NEVER cite `amountPaise` directly as a rupee value (it is in paise, where 100 paise = ₹1).',
      '',
      'Decide the disposition by walking the matrix top-to-bottom and stopping at the first rule that fires.',
    ].join('\n');
    let out: Disposition;
    try {
      const r = await agent.generate(prompt, {
        structuredOutput: { schema: DispositionSchema },
      });
      out = (r as unknown as { object: Disposition }).object;
    } catch (err) {
      const msg = (err as Error).message;
      return { name: c.name, category: c.category, configId: c.configId, passed: false, detail: `agent error: ${msg}` } as CaseResult;
    }

    const dRes = await dispositionAccuracyScorer.run({
      input: { expectedRecommendation: c.expected.recommendation },
      output: { recommendation: out.recommendation, reasoning: out.reasoning },
      // scorer compares against groundTruth.recommendation (not input) — see
      // scorers.ts. Pass groundTruth explicitly so the CLI eval matches what
      // the Studio dataset path provides.
      groundTruth: { recommendation: c.expected.recommendation },
    } as Parameters<typeof dispositionAccuracyScorer.run>[0]);
    const passed = dRes.score === 1;
    return {
      name: c.name, category: c.category, configId: c.configId, passed,
      detail: passed ? `${out.recommendation} ✓` : `expected ${c.expected.recommendation}, got ${out.recommendation}`,
    } as CaseResult;
  });

  // Print in input order
  for (let i = 0; i < acc.length; i++) {
    const c = DISPOSITION_CASES[i];
    const r = acc[i];
    const marker = r.passed ? '✓' : '✗';
    console.log(`  ${marker} [${c.category}] ${c.name}`);
    if (!r.passed) console.log(`     • ${r.detail}`);
  }

  return { dispositionAccuracy: acc };
}

// ─── Pretty report ───────────────────────────────────────────────────────────

function printReport(allResults: {
  candidateValidity: CaseResult[];
  bestCandidatePick: CaseResult[];
  reasoning: CaseResult[];
  dispositionAccuracy: CaseResult[];
}) {
  const { candidateValidity, bestCandidatePick, reasoning, dispositionAccuracy } = allResults;

  console.log(`\n${'='.repeat(78)}`);
  console.log('  HEADLINE NUMBERS');
  console.log('='.repeat(78));
  const v = candidateValidity.filter(r => r.passed).length;
  const p = bestCandidatePick.filter(r => r.passed).length;
  const reasonAvg = reasoning.reduce((a, b) => a + (b.reasoningScore ?? 0), 0) / Math.max(1, reasoning.length);
  const d = dispositionAccuracy.filter(r => r.passed).length;

  console.log(`  Candidate Validity     : ${pct(v, candidateValidity.length)}     (no hallucinated IDs)`);
  console.log(`  Best-Candidate Pick    : ${pct(p, bestCandidatePick.length)}     (matches expected pick)`);
  console.log(`  Reasoning Quality      : ${reasonAvg.toFixed(2)} avg (LLM-judged 0..1, ${reasoning.length} cases)`);
  console.log(`  Disposition Accuracy   : ${pct(d, dispositionAccuracy.length)}     (matches expected recommendation)`);

  console.log(`\n${'='.repeat(78)}`);
  console.log('  BY CATEGORY  (best-candidate pick + disposition combined)');
  console.log('='.repeat(78));
  const pickByCat = makeCategoryReport(bestCandidatePick);
  const dispByCat = makeCategoryReport(dispositionAccuracy);
  for (const cat of CATEGORIES) {
    const pk = pickByCat.get(cat)!;
    const dp = dispByCat.get(cat)!;
    const total = pk.total + dp.total;
    if (total === 0) continue;
    const passed = pk.passed + dp.passed;
    console.log(`  ${cat.padEnd(22)} ${pct(passed, total)}`);
  }
  console.log('');
}

// ─── Per-config × per-category scoreboard (Plan B#5) ─────────────────────────

/**
 * Pivots `bestCandidatePick` + `dispositionAccuracy` results into a matrix
 * with configId as rows and category as columns. Cells are pass-rate strings.
 *
 * Cases without a configId are bucketed as 'common'. Empty cells show '·'.
 */
function printConfigMatrix(results: CaseResult[]) {
  // Group counts: configId → category → { passed, total }
  type Counts = Map<string, Map<Category, { passed: number; total: number }>>;
  const grid: Counts = new Map();
  for (const r of results) {
    const cfg = r.configId ?? 'common';
    if (!grid.has(cfg)) grid.set(cfg, new Map());
    const row = grid.get(cfg)!;
    const cell = row.get(r.category) ?? { passed: 0, total: 0 };
    cell.total += 1;
    if (r.passed) cell.passed += 1;
    row.set(r.category, cell);
  }
  const configs = [...grid.keys()].sort();
  // Only print categories that have at least one cell populated.
  const usedCats = CATEGORIES.filter(cat =>
    configs.some(cfg => (grid.get(cfg)?.get(cat)?.total ?? 0) > 0),
  );

  console.log(`\n${'='.repeat(78)}`);
  console.log('  BY CONFIG × CATEGORY  (pick + disposition combined)');
  console.log('='.repeat(78));

  const colWidth = 14;
  const firstCol = 24;
  const header = 'config'.padEnd(firstCol) + usedCats.map(c => c.padEnd(colWidth)).join('');
  console.log('  ' + header);
  console.log('  ' + '-'.repeat(header.length));

  for (const cfg of configs) {
    const row = grid.get(cfg)!;
    const cells = usedCats.map(cat => {
      const cell = row.get(cat);
      if (!cell || cell.total === 0) return '·'.padEnd(colWidth);
      return `${Math.round((cell.passed / cell.total) * 100)}% (${cell.passed}/${cell.total})`.padEnd(colWidth);
    });
    console.log('  ' + cfg.padEnd(firstCol) + cells.join(''));
  }
  console.log('');
}

// ─── Snapshot persistence + regression detection (Plan B#5) ──────────────────

interface RunSnapshot {
  timestamp: string;
  matcherVersion: string;
  totals: {
    candidateValidity: { passed: number; total: number };
    bestCandidatePick: { passed: number; total: number };
    reasoningAvg: number;
    dispositionAccuracy: { passed: number; total: number };
  };
  byConfig: Record<string, Record<string, { passed: number; total: number }>>;
}

const RESULTS_DIR = new URL('./results/', import.meta.url);

async function saveSnapshot(snap: RunSnapshot): Promise<string> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const safeStamp = snap.timestamp.replace(/[:.]/g, '-');
  const file = new URL(`${safeStamp}.json`, RESULTS_DIR);
  await fs.writeFile(file, JSON.stringify(snap, null, 2));
  return file.pathname;
}

async function loadLatestPrior(currentStamp: string): Promise<RunSnapshot | null> {
  const fs = await import('node:fs/promises');
  let files: string[];
  try {
    files = await fs.readdir(RESULTS_DIR);
  } catch {
    return null;
  }
  const safeCurrent = currentStamp.replace(/[:.]/g, '-');
  const prior = files
    .filter(f => f.endsWith('.json') && !f.startsWith(safeCurrent))
    .sort()
    .pop();
  if (!prior) return null;
  const raw = await fs.readFile(new URL(prior, RESULTS_DIR), 'utf8');
  return JSON.parse(raw) as RunSnapshot;
}

function buildSnapshot(allResults: {
  candidateValidity: CaseResult[];
  bestCandidatePick: CaseResult[];
  reasoning: CaseResult[];
  dispositionAccuracy: CaseResult[];
}): RunSnapshot {
  const { candidateValidity, bestCandidatePick, reasoning, dispositionAccuracy } = allResults;
  const sum = (rs: CaseResult[]) => ({
    passed: rs.filter(r => r.passed).length,
    total: rs.length,
  });
  // Combine pick + disposition for the per-config grid (same as printed table).
  const byConfig: Record<string, Record<string, { passed: number; total: number }>> = {};
  for (const r of [...bestCandidatePick, ...dispositionAccuracy]) {
    const cfg = r.configId ?? 'common';
    byConfig[cfg] = byConfig[cfg] ?? {};
    const cell = byConfig[cfg][r.category] ?? { passed: 0, total: 0 };
    cell.total += 1;
    if (r.passed) cell.passed += 1;
    byConfig[cfg][r.category] = cell;
  }
  return {
    timestamp: new Date().toISOString(),
    matcherVersion: 'v2.1.0',
    totals: {
      candidateValidity: sum(candidateValidity),
      bestCandidatePick: sum(bestCandidatePick),
      reasoningAvg:
        reasoning.reduce((a, b) => a + (b.reasoningScore ?? 0), 0) /
        Math.max(1, reasoning.length),
      dispositionAccuracy: sum(dispositionAccuracy),
    },
    byConfig,
  };
}

function diffSnapshots(prior: RunSnapshot, current: RunSnapshot): {
  improved: string[];
  regressed: string[];
} {
  const improved: string[] = [];
  const regressed: string[] = [];
  const fmt = (n: number) => `${(n * 100).toFixed(0)}%`;
  // Compare totals
  const pairs: Array<[string, { passed: number; total: number }, { passed: number; total: number }]> = [
    ['candidate-validity', prior.totals.candidateValidity, current.totals.candidateValidity],
    ['best-candidate-pick', prior.totals.bestCandidatePick, current.totals.bestCandidatePick],
    ['disposition-accuracy', prior.totals.dispositionAccuracy, current.totals.dispositionAccuracy],
  ];
  for (const [label, p, c] of pairs) {
    const before = p.total === 0 ? 0 : p.passed / p.total;
    const after = c.total === 0 ? 0 : c.passed / c.total;
    if (after > before + 0.02) improved.push(`${label}: ${fmt(before)} → ${fmt(after)}`);
    if (after < before - 0.02) regressed.push(`${label}: ${fmt(before)} → ${fmt(after)}`);
  }
  return { improved, regressed };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  // Two evals are independent → run them in parallel
  const [fuzzy, disp] = await Promise.all([runFuzzyEval(), runDispositionEval()]);
  const all = { ...fuzzy, ...disp };
  printReport(all);

  // Plan B#5: per-config × per-category matrix
  printConfigMatrix([...all.bestCandidatePick, ...all.dispositionAccuracy]);

  // Plan B#5: snapshot + regression detection
  const snap = buildSnapshot(all);
  const prior = await loadLatestPrior(snap.timestamp);
  const snapPath = await saveSnapshot(snap);
  console.log(`Snapshot: ${snapPath}`);
  if (prior) {
    const { improved, regressed } = diffSnapshots(prior, snap);
    if (improved.length || regressed.length) {
      console.log(`\nVs prior run (${prior.timestamp}):`);
      for (const m of improved) console.log(`  ↑ ${m}`);
      for (const m of regressed) console.log(`  ↓ ${m}`);
    } else {
      console.log(`Vs prior run (${prior.timestamp}): no significant change (±2%).`);
    }
  } else {
    console.log('No prior snapshot — this run becomes the baseline.');
  }

  console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
