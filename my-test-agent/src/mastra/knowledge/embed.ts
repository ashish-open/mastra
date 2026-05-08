/**
 * OpenAI Embeddings helper.
 *
 * Used by both the ingest script (to embed KB chunks) and the knowledge-agent
 * search-knowledge tool (to embed user queries). Both sides MUST use the same
 * model so that vectors live in the same space.
 *
 * Why direct fetch instead of the openai SDK:
 *   - No extra dependency to install/version-pin.
 *   - The Embeddings endpoint is tiny — one POST.
 *   - Easier to add retry/backoff later without fighting the SDK's interceptors.
 */

import { EMBEDDING_MODEL } from './vector.js';

const OPENAI_BASE = 'https://api.openai.com/v1';

interface OpenAIEmbeddingResponse {
  object: 'list';
  data: Array<{ object: 'embedding'; index: number; embedding: number[] }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Embed one or more strings. Up to 2048 inputs per call (OpenAI limit).
 * Returns an array of embedding vectors in the same order as inputs.
 */
export async function embed(inputs: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY env var is not set');
  if (inputs.length === 0) return [];

  // Chunk into batches of 256 to stay well under OpenAI's per-request token limit
  const BATCH = 256;
  const result: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const slice = inputs.slice(i, i + BATCH);
    const res = await fetch(`${OPENAI_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: slice }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenAI embeddings failed (${res.status}): ${txt}`);
    }
    const json = (await res.json()) as OpenAIEmbeddingResponse;
    // OpenAI returns sorted by index, but defensively re-sort
    json.data.sort((a, b) => a.index - b.index);
    result.push(...json.data.map(d => d.embedding));
  }
  return result;
}

export async function embedOne(input: string): Promise<number[]> {
  const [v] = await embed([input]);
  return v;
}
