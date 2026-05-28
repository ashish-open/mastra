#!/usr/bin/env tsx
/**
 * Smoke test for the YES Bank UPI Settlement pilot reco.
 *
 * Bypasses the HTTP layer and exercises the full deterministic pipeline:
 *
 *   1. Loads the 4 PII-masked sample files from ./pii-masked/
 *   2. Parses each via its adapter
 *   3. Runs `runLegs(getConfig('settlement-yes-pg'), fetched)`
 *   4. Prints a per-leg + per-rule + per-match-type breakdown
 *
 * This is the engineer-facing equivalent of what finance team will get as
 * `00_run_summary.csv` in the report pack (Phase 4). Use this to validate the
 * pilot logic against real data before wiring up the HTTP / OpenArc UI.
 *
 * Usage:
 *   pnpm tsx scripts/smoke-yes-settlement.ts
 *
 * Requires masked files at:
 *   pii-masked/yes-mis.csv
 *   pii-masked/yes-pg-incoming.csv
 *   pii-masked/yes-consolidated.csv
 *   pii-masked/yes-statement.csv
 *
 * Run mask-reco-pii.ts first if you only have the raw workbook.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

import './../src/mastra/reconciliation/configs.js';
import { getConfig, getAdapter } from '../src/mastra/reconciliation/adapter.js';
import { runLegs } from '../src/mastra/reconciliation/legs.js';
import {
  getDispositionRules,
  applyDispositionRules,
} from '../src/mastra/reconciliation/disposition/engine.js';
import { buildReportPack } from '../src/mastra/reconciliation/reports/report-pack-builder.js';
import type { NormalizedTxn, RecoDecision } from '../src/mastra/reconciliation/types.js';

const FILES: Array<{ adapterId: string; path: string }> = [
  { adapterId: 'pg-yes-mis',          path: 'pii-masked/yes-mis.csv' },
  { adapterId: 'pg-yes-incoming',     path: 'pii-masked/yes-pg-incoming.csv' },
  { adapterId: 'pg-yes-consolidated', path: 'pii-masked/yes-consolidated.csv' },
  { adapterId: 'bank',                path: 'pii-masked/yes-statement.csv' },
];

async function main() {
  console.log('YES Settlement smoke test');
  console.log('═'.repeat(78));

  const config = getConfig('settlement-yes-pg');
  console.log(`Config: ${config.name} (${config.id})`);
  console.log(`  llm=${config.llm}  legs=${config.legs?.length}  expectedResolutionDays=${config.expected_resolution_days}`);
  console.log('');

  // 1. Parse every input file via its adapter.
  const fetched: { adapterId: string; txns: NormalizedTxn[] }[] = [];
  for (const f of FILES) {
    const abs = resolve(f.path);
    if (!existsSync(abs)) {
      console.error(`✗ Missing file: ${abs}`);
      console.error(`  Run \`scripts/mask-reco-pii.ts\` to generate or place a masked CSV here.`);
      process.exit(1);
    }
    const buf = readFileSync(abs);
    const adapter = getAdapter(f.adapterId);
    if (!adapter.parseFile) {
      throw new Error(`Adapter '${f.adapterId}' has no parseFile method`);
    }
    const ctx = { date: '2026-05-21', accountId: f.adapterId === 'bank' ? 'yes-current' : undefined };
    const txns = await adapter.parseFile(buf, 'text/csv', ctx);
    fetched.push({ adapterId: f.adapterId, txns });
    console.log(`  parsed ${f.adapterId.padEnd(22)} → ${String(txns.length).padStart(4)} txns from ${f.path}`);
  }
  console.log('');

  // 2. Run the leg cascade.
  console.log('Running legs…');
  console.log('─'.repeat(78));
  const { exactDecisions: decisions, unmatched, candidatePool } = runLegs(config, fetched);
  console.log('─'.repeat(78));

  // 3. Per-leg breakdown.
  console.log('');
  console.log('Per-leg decisions');
  console.log('═'.repeat(78));
  const byLeg = groupBy(decisions, d => d.metadata?.legId ?? '(no-leg)');
  for (const leg of config.legs ?? []) {
    const legDec = byLeg.get(leg.id) ?? [];
    const byType = groupBy(legDec, d => d.matchType);
    console.log(`  ${leg.id.padEnd(36)}  ${String(legDec.length).padStart(4)} decisions`);
    for (const [t, arr] of byType) {
      console.log(`      ${t.padEnd(20)} ${String(arr.length).padStart(4)}`);
    }
  }
  const noLeg = byLeg.get('(no-leg)') ?? [];
  if (noLeg.length > 0) {
    console.log(`  (no-leg)                              ${noLeg.length} decisions (should be 0 for multi-leg configs)`);
  }
  console.log('');

  // 4. Headline counts.
  console.log('Headline');
  console.log('═'.repeat(78));
  console.log(`  total decisions ........ ${decisions.length}`);
  console.log(`  unmatched residual ..... ${unmatched.length}`);
  console.log(`  candidatePool .......... ${candidatePool.length}`);
  const matched = decisions.filter(d => d.matchType !== 'excluded' && d.matchType !== 'unmatched');
  const excluded = decisions.filter(d => d.matchType === 'excluded');
  console.log(`  matched (any leg) ...... ${matched.length}`);
  console.log(`  excluded (already-settled) ${excluded.length}`);
  console.log('');

  // 5. Sample a few decisions per leg so we can eyeball metadata coverage.
  console.log('Sample decisions (1 per leg, first found)');
  console.log('═'.repeat(78));
  for (const leg of config.legs ?? []) {
    const sample = (byLeg.get(leg.id) ?? [])[0];
    if (!sample) {
      console.log(`  ${leg.id}: (none)`);
      continue;
    }
    console.log(`  ${leg.id}:`);
    console.log(`     matchType:    ${sample.matchType}`);
    console.log(`     ruleId:       ${sample.metadata?.ruleId ?? '(unset)'}`);
    console.log(`     ruleSource:   ${sample.metadata?.ruleSource ?? '(unset)'}`);
    console.log(`     joinKeyUsed:  ${JSON.stringify(sample.metadata?.joinKeyUsed)}`);
    console.log(`     normalizations: ${JSON.stringify(sample.metadata?.normalizations)}`);
    console.log(`     reasoning:    ${sample.reasoning ?? '(unset)'}`);
  }
  console.log('');

  // 6. Apply deterministic disposition rules per the YES SOP (5 scenarios).
  const dispo = getDispositionRules('settlement-yes-pg');
  if (!dispo) {
    console.error('✗ No disposition rules registered for settlement-yes-pg');
    process.exit(2);
  }
  const summaries = applyDispositionRules({
    fetched,
    decisions,
    rules: dispo.rules,
    config: dispo.apply,
  });

  console.log('Per-bucket disposition (1 summary decision per MIS row)');
  console.log('═'.repeat(78));
  const byBucket = groupBy(summaries, s => s.metadata?.disposition?.bucket ?? 'no_disposition');
  const bucketOrder = [
    'settle', 'refund_late_authorized', 'refund_timeout',
    'ignore_failed', 'escalate_missing_pg', 'escalate_product_support', 'no_disposition',
  ];
  for (const bucket of bucketOrder) {
    const rows = byBucket.get(bucket) ?? [];
    if (rows.length === 0) continue;
    console.log(`  ${bucket.padEnd(28)}  ${String(rows.length).padStart(4)}  ${rows[0].reasoning?.slice(0, 100) ?? ''}`);
  }
  console.log(`  ${'TOTAL'.padEnd(28)}  ${String(summaries.length).padStart(4)}`);
  console.log('');

  // 7. Quick sanity: every decision must have legId + ruleId + ruleSource.
  const missingProvenance = decisions.filter(
    d => !d.metadata?.legId || !d.metadata?.ruleId || !d.metadata?.ruleSource,
  );
  if (missingProvenance.length > 0) {
    console.error(`✗ ${missingProvenance.length} decisions are missing provenance metadata.`);
    console.error(`  Example: ${JSON.stringify(missingProvenance[0], null, 2)}`);
    process.exit(2);
  }
  console.log('✓ All decisions carry legId + ruleId + ruleSource (Principle 4 — reproducibility).');

  // 8. Build the report pack and write it to disk for finance-team inspection.
  const allDecisions = [...decisions, ...summaries];
  const pack = buildReportPack({
    runId: 'yes-smoke',
    configId: 'settlement-yes-pg',
    date: '2026-05-21',
    config,
    fetched,
    decisions: allDecisions,
    warnings: [],
  });

  const outRoot = resolve('run-reports', pack.rootDir);
  console.log('');
  console.log('Report pack');
  console.log('═'.repeat(78));
  console.log(`  ${pack.summary}`);
  console.log(`  Writing to: ${outRoot}`);
  for (const f of pack.files) {
    const full = join(outRoot, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.contents);
    const lineCount = f.contents.split('\n').filter(l => l.length > 0).length;
    console.log(`    ${f.path.padEnd(50)} ${String(lineCount).padStart(5)} lines`);
  }
}

function groupBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const t of arr) {
    const k = key(t);
    const v = m.get(k);
    if (v) v.push(t);
    else m.set(k, [t]);
  }
  return m;
}

main().catch(e => {
  console.error('Smoke test failed:', e);
  process.exit(1);
});
