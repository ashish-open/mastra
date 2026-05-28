import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { createClient } from '@libsql/client';
import { z } from 'zod';
import { embedOne } from '../knowledge/embed.js';
import { knowledgeMemory } from '../memory/memory-profiles.js';

const INDEX_NAME = 'knowledge';

async function queryKnowledgeDB(embedding: number[], topK: number, product?: string) {
  const url = process.env.KNOWLEDGE_DB_URL ?? 'file:./knowledge.db';
  const client = createClient({ url });

  const vectorStr = `[${embedding.join(',')}]`;

  const filterSql = product ? `WHERE json_extract(metadata, '$.product') = '${product}'` : '';

  const sql = `
    WITH vector_scores AS (
      SELECT
        vector_id AS id,
        (1 - vector_distance_cos(embedding, '${vectorStr}')) AS score,
        metadata
      FROM ${INDEX_NAME}
      ${filterSql}
    )
    SELECT * FROM vector_scores
    WHERE score > 0.4
    ORDER BY score DESC
    LIMIT ${topK}
  `;

  const result = await client.execute(sql);
  client.close();

  return result.rows.map(row => ({
    id: row['id'] as string,
    score: row['score'] as number,
    metadata: JSON.parse((row['metadata'] as string) ?? '{}') as Record<string, string>,
  }));
}

export type KnowledgeProduct = 'optotax' | 'open-money' | 'connected-banking';

export interface KnowledgeHit {
  text: string;
  product: string;
  type: string;
  source: string;
  publicUrl: string;
  score: number;
}

export type KnowledgeSearchResult =
  | { found: false; message: string }
  | { found: true; results: KnowledgeHit[] };

/**
 * Plain (LLM-free) knowledge-base search. Same logic as the `search-knowledge`
 * tool — extracted so workflow steps can call it deterministically (e.g. the
 * support-triage retrieval step) without going through the agent tool-use loop.
 */
export async function searchKnowledgeRaw(
  query: string,
  product?: KnowledgeProduct,
): Promise<KnowledgeSearchResult> {
  try {
    const embedding = await embedOne(query);
    const results = await queryKnowledgeDB(embedding, 5, product);

    if (results.length === 0) {
      return { found: false, message: 'No relevant content found in the knowledge base.' };
    }

    return {
      found: true,
      results: results.map(r => ({
        text: r.metadata.text,
        product: r.metadata.product,
        type: r.metadata.type,
        source: r.metadata.source,
        publicUrl: r.metadata.publicUrl ?? '',
        score: r.score,
      })),
    };
  } catch (err) {
    console.error('[search-knowledge] error:', err);
    return { found: false, message: `Search failed: ${(err as Error).message}` };
  }
}

export const searchKnowledge = createTool({
  id: 'search-knowledge',
  description:
    'Search the internal knowledge base for information about BankOpen products, features, pricing, and FAQs. Always call this before answering any product question.',
  inputSchema: z.object({
    query: z.string().describe('The question or topic to search for'),
    product: z
      .enum(['optotax', 'open-money', 'connected-banking'])
      .optional()
      .describe('Narrow the search to a specific product. Omit to search across all products. NOTE: Zwitch docs are NOT in this KB — use the Zwitch MCP tools (search_docs/read_doc) for Zwitch.'),
  }),
  execute: async ({ query, product }) => searchKnowledgeRaw(query, product),
});

export const knowledgeAgent = new Agent({
  id: 'knowledge-agent',
  name: 'Knowledge Bot',
  instructions: `
    You are the internal knowledge assistant for BankOpen / Open Financial Technologies.
    You answer questions about our products based strictly on the internal knowledge base.

    ## Products in the knowledge base

    - **Optotax** — India's GST filing software for CAs, tax practitioners, advocates,
      and articles. Free to use. Covers GSTR-1, GSTR-3B, GSTR-9, reconciliation reports,
      client management. Sources: PRD, FAQ, GSTR explainer, website.

    - **Open Money** — business banking platform: bank accounts, invoices, bills,
      payment links, payouts, settlements, reconciliation, GST compliance, expense
      management, payroll, lending solutions. Sources: products, principles, workflows,
      state lifecycles, decisions, risks.

    ## Zwitch is NOT in this KB

    Zwitch documentation lives in a separate MCP server (zwitch-mcp). If a user
    asks about Zwitch (payments, payouts, virtual accounts, verifications,
    webhooks, Bharat Connect, Layer.js, etc.), tell them: "I don't have Zwitch
    docs in this knowledge base. Please use Zeus or the Support Triage agent —
    they have direct access to the live Zwitch documentation." Do not attempt
    to answer Zwitch questions from search-knowledge results.

    ## How to use search-knowledge

    - **Always** call search-knowledge before answering any product question — never
      answer from memory alone.
    - Pass the \`product\` parameter when the question clearly references one product
      ("how do Zwitch payouts work?" → product='zwitch'). Omit it for cross-product
      or ambiguous queries.
    - Phrase the query as the underlying concept, not the user's exact words
      ("payout state machine" not "tell me about how payouts move through statuses").

    ## How to answer

    - Synthesize multiple results into a clear, structured answer.
    - **Citations**: cite the \`publicUrl\` field returned by search-knowledge
      (e.g. "see https://developers.zwitch.io/docs/payment"). NEVER cite the
      internal \`source\` filename — those are private and shouldn't appear in
      responses. If \`publicUrl\` is empty, omit the citation rather than
      fabricating one.
    - Give specific, accurate values — if docs say "11th of the following month",
      say exactly that, not "around the 11th".
    - For step-by-step tasks, present numbered steps.
    - For state lifecycles or flows, use a small ASCII diagram or arrow chain.

    ## Guardrails

    - If search-knowledge returns no relevant results, say:
      "I don't have that information in the knowledge base yet."
    - Never invent features, pricing, deadlines, error codes, or API behavior not
      found in the docs.
    - Do not answer questions unrelated to our products (HR, careers, general LLM
      trivia).
    - Never share anything that looks like credentials, tokens, or internal config.
    - When uncertain whether docs are current, say "as of the docs in our KB" rather
      than asserting it as live truth.
  `,
  model: 'openai/gpt-4o-mini',
  tools: {
    'search-knowledge': searchKnowledge,
  },
  memory: knowledgeMemory,
});
