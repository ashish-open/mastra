import { MDocument } from '@mastra/rag';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { knowledgeVector, INDEX_NAME, DIMENSION, EMBEDDING_MODEL } from './vector.js';
import { embed } from './embed.js';
import { publicUrlForSource } from './url-mapping.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..'); // my-test-agent root

// External KB tree shared with the AgentX project
const EXTERNAL_KB_ROOT = '/Users/ashish.s/Documents/AgentX/Agent_X/knowledge_base';

// Files inside the external KB that describe the KB itself, not the product —
// skip these so they don't pollute search results.
const META_FILE_PATTERNS = [
  /^README\.md$/i,
  /^KB_/i,
  /^ANALYSIS_/i,
  /^COMPLETE_KB_/i,
  /^CURRENT_PHASE_/i,
  /^FILE_REFERENCE_/i,
  /^FIX_/i,
  /^IMMEDIATE_/i,
  /^IMPROVEMENT_/i,
  /^KNOWLEDGE_BASE_EXPLAINED/i,
  /^RAG_SYSTEM_/i,
  /^URL_MAPPING_/i,
];

interface Source {
  product: string;
  type: string;
  /** Either an absolute path, or a path relative to ROOT */
  file: string;
}

const SOURCES: Source[] = [
  // ── Optotax ───────────────────────────────────────────────────
  { file: 'OPTOTAX PRD.md',                    product: 'optotax', type: 'prd' },
  { file: 'Explainer-GSTR_Reports_OPTOTAX.md', product: 'optotax', type: 'explainer' },
  { file: '_FAQ - Optotax.md',                 product: 'optotax', type: 'faq' },
  { file: 'Optotax-Website-2026.md',           product: 'optotax', type: 'website' },
];

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === '_meta') continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.endsWith('.md') && !META_FILE_PATTERNS.some(re => re.test(entry))) {
      out.push(full);
    }
  }
  return out;
}

// Zwitch docs are NOT ingested into the static KB — they live in zwitch-mcp
// (https://uat-zwitch-mcp.bankopen.co/mcp) which serves them live and is more
// authoritative + always up-to-date. Agents that need Zwitch context call the
// MCP's search_docs / read_doc tools instead.

const openMoneyDir = resolve(EXTERNAL_KB_ROOT, 'openmoney');
try {
  for (const f of walkMarkdown(openMoneyDir)) {
    SOURCES.push({ product: 'open-money', type: 'docs', file: f });
  }
  console.log(`Found ${SOURCES.filter(s => s.product === 'open-money').length} Open Money files`);
} catch (err) {
  console.warn(`Open Money KB folder not found at ${openMoneyDir} — skipping`);
}

async function ingest() {
  console.log('Creating vector index...');
  await knowledgeVector.createIndex({ indexName: INDEX_NAME, dimension: DIMENSION });

  let totalChunks = 0;
  for (let i = 0; i < SOURCES.length; i++) {
    const source = SOURCES[i];
    const filePath = source.file.startsWith('/') ? source.file : resolve(ROOT, source.file);
    const displayName =
      source.file.startsWith('/') ? relative(EXTERNAL_KB_ROOT, source.file) : source.file;

    console.log(`\n[${i + 1}/${SOURCES.length}] ${source.product}/${source.type} — ${displayName}`);

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.warn(`  ⚠️  Cannot read ${filePath} — skipping`);
      continue;
    }

    const doc = MDocument.fromMarkdown(content);
    await doc.chunk({ strategy: 'recursive', maxSize: 512 });

    const texts = doc.getText().filter(t => {
      const trimmed = t.trim();
      if (trimmed.length < 30) return false;
      const spaces = (trimmed.match(/ /g) || []).length;
      const spaceRatio = spaces / trimmed.length;
      return spaceRatio > 0.04;
    });
    if (texts.length === 0) {
      console.log(`  No usable chunks, skipping.`);
      continue;
    }

    console.log(`  Embedding ${texts.length} chunks via OpenAI ${EMBEDDING_MODEL}...`);
    const embeddings = await embed(texts);

    // Use display name in IDs to avoid collisions across nested files
    const idPrefix = `${source.product}-${source.type}-${displayName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const ids = texts.map((_, k) => `${idPrefix}-${k}`);
    const publicUrl = publicUrlForSource(displayName);
    const metadata = texts.map((text, k) => ({
      product: source.product,
      type: source.type,
      source: displayName,
      publicUrl,
      chunkIndex: k,
      text,
    }));

    await knowledgeVector.upsert({
      indexName: INDEX_NAME,
      vectors: embeddings,
      ids,
      metadata,
    });

    totalChunks += texts.length;
    console.log(`  ✓ Stored ${texts.length} chunks`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Ingest complete. ${totalChunks} chunks across ${SOURCES.length} sources.`);
  console.log('Distribution:');
  for (const product of ['optotax', 'open-money']) {
    const count = SOURCES.filter(s => s.product === product).length;
    if (count > 0) console.log(`  ${product}: ${count} files`);
  }
  console.log('  zwitch: served live by zwitch-mcp (not ingested)');
}

ingest().catch(err => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
