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

interface CaseResult {
  name: string;
  category: Category;
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
      JSON.stringify(c.input.unmatched, null, 2),
      '',
      'Candidate pool (transactions from OTHER sources):',
      JSON.stringify(c.input.candidatePool, null, 2),
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
      name: c.name, category: c.category, passed: vPass,
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
      name: c.name, category: c.category, passed: pickPass,
      detail: pickPass
        ? `${actual ?? 'null'} ✓`
        : expected === actual
          ? `id ok (${actual}) but score=${out.bestCandidate?.similarityScore} outside [${c.expected.minScore ?? '−∞'}..${c.expected.maxScore ?? '∞'}]`
          : `expected '${expected}', got '${actual}' (score=${out.bestCandidate?.similarityScore ?? 'n/a'})`,
    };

    const reasoning: CaseResult = {
      name: c.name, category: c.category, passed: rScore >= 0.5,
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
      JSON.stringify(c.input.sourceTxn, null, 2),
      '',
      'Fuzzy match result:',
      JSON.stringify(c.input.fuzzyResult, null, 2),
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
      return { name: c.name, category: c.category, passed: false, detail: `agent error: ${msg}` } as CaseResult;
    }

    const dRes = await dispositionAccuracyScorer.run({
      input: { expectedRecommendation: c.expected.recommendation },
      output: { recommendation: out.recommendation, reasoning: out.reasoning },
    });
    const passed = dRes.score === 1;
    return {
      name: c.name, category: c.category, passed,
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  // Two evals are independent → run them in parallel
  const [fuzzy, disp] = await Promise.all([runFuzzyEval(), runDispositionEval()]);
  printReport({ ...fuzzy, ...disp });
  console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
