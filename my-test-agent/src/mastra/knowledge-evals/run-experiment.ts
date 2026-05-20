/**
 * Run a Mastra-native experiment for the Knowledge Bot retrieval eval.
 *
 *   pnpm eval:knowledge:exp
 *
 * Measures retrieval-only: did `searchKnowledge` (the agent's RAG tool)
 * return at least one of the expected source documents in its top-K
 * results? This isolates retrieval quality from answer quality — both
 * matter, but they fail for different reasons and need different fixes.
 *
 * Answer faithfulness (an LLM-judged scorer on the agent's free-text
 * reply) is a follow-up — we'd add it as a second scorer on this same
 * dataset once the retrieval baseline is solid.
 */

import { mastra } from '../index.js';
import { seedKnowledgeDataset } from './seed-datasets.js';
import { searchKnowledge } from '../agents/knowledge-agent.js';
import type { KnowledgeEvalCase } from './dataset.js';

interface TaskInput {
  question: string;
  product?: KnowledgeEvalCase['product'];
}
interface TaskOutput {
  retrievedSources: string[];
}
interface TaskGroundTruth {
  expectedSources: string[];
}

async function main(): Promise<void> {
  const report = await seedKnowledgeDataset(mastra);
  const dataset = await mastra.datasets.get({ id: report.datasetId });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const summary = await dataset.startExperiment<TaskInput, TaskOutput, TaskGroundTruth>({
    name: `Knowledge Retrieval — ${stamp}`,
    description: 'searchKnowledge tool retrieval recall@K vs labeled questions',
    // Lower concurrency than reco — each call does an embedding API hit plus
    // a libsql vector query, both rate-limit-sensitive.
    maxConcurrency: 4,
    task: async ({ input }) => {
      // searchKnowledge.execute is typed loosely; cast at the call site.
      // The tool returns either { found: false, ... } or
      // { found: true, results: [{ source, score, ... }] }.
      const exec = (searchKnowledge as unknown as {
        execute: (
          args: { query: string; product?: string },
          ctx?: unknown
        ) => Promise<
          | { found: false; message: string }
          | { found: true; results: Array<{ source: string; score: number }> }
        >;
      }).execute;
      const result = await exec({ query: input.question, product: input.product }, {});
      if (!result.found) return { retrievedSources: [] };
      return { retrievedSources: result.results.map(r => r.source) };
    },
    scorers: ['knowledge-retrieval-recall'],
  });

  console.log(
    `[knowledge] Retrieval experiment ${summary.experimentId} — ` +
    `${summary.succeededCount}/${summary.totalItems} ok, ${summary.failedCount} failed`
  );
  process.exit(0);
}

main().catch(err => {
  console.error('[knowledge] run-experiment failed:', err);
  process.exit(1);
});
