import { LibSQLVector } from '@mastra/libsql';

export const INDEX_NAME = 'knowledge';

/**
 * OpenAI text-embedding-3-small.
 * - Dimension: 1536
 * - Cost: $0.02 / 1M tokens
 * - Multilingual, good general retrieval quality
 *
 * If you switch model, also update DIMENSION and re-ingest from scratch
 * (mismatched dimensions will fail at upsert/query time).
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const DIMENSION = 1536;

export const knowledgeVector = new LibSQLVector({
  id: 'knowledge-vector',
  url: process.env.KNOWLEDGE_DB_URL ?? 'file:./knowledge.db',
});
