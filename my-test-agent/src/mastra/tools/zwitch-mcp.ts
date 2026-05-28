/**
 * Shared zwitch-mcp client.
 *
 * The zwitch-mcp server (https://uat-zwitch-mcp.bankopen.co/mcp) exposes
 * two classes of tools:
 *
 *   READ-ONLY DOCS TOOLS (safe everywhere):
 *     search_docs, list_docs, read_doc, zwitch_setup,
 *     get_payment_gateway_guide, get_account_setup_guide, get_beneficiary_guide,
 *     get_payouts_guide, get_collections_guide, get_verification_guide,
 *     get_webhook_guide
 *
 *   LIVE-ACTION TOOLS (zeus-agent only — these touch customer data / make payments):
 *     create_*, update_*, delete_*, verify_*, find_txn_*, get_balance,
 *     list_transfers, list_payments, etc.
 *
 * Triage and meeting agents should ONLY use the docs subset to ground answers
 * in canonical Zwitch documentation. Never give them live-action tools — those
 * could trigger real money movement during a tool-call hallucination.
 */

import { MCPClient } from '@mastra/mcp';

export const zwitchMCP = new MCPClient({
  servers: {
    zwitch: {
      url: new URL('https://mcp.zwitch.io/mcp'),
      // Default timeout is 3s which is too aggressive for cold starts;
      // raise it so initial listTools() doesn't error during dev startup.
      timeout: 15000,
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.ZWITCH_API_KEY}`,
        },
      },
    },
  },
});

/**
 * All tools (live actions + docs). Use only in zeus-agent.
 * If the MCP is unreachable at startup we log a warning and return {} so the
 * rest of the app still loads — agents that depend on this just won't have
 * Zwitch tools until the MCP comes back.
 */
export const zwitchAllTools: Record<string, unknown> = await zwitchMCP
  .listTools()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[zwitch-mcp] ⚠️  Could not load tools (${msg}). Agents will run without Zwitch docs.`);
    return {} as Record<string, unknown>;
  });

console.log('[zwitch-mcp] All tool keys returned by MCPClient.listTools():');
for (const key of Object.keys(zwitchAllTools)) {
  console.log(`  - ${key}`);
}

/**
 * Docs-only subset — safe for any agent that needs to look up Zwitch info
 * but should NOT make live API calls. Filters by tool-name prefix/suffix.
 */
const DOCS_TOOL_NAMES = new Set([
  'search_docs',
  'list_docs',
  'read_doc',
  'zwitch_setup',
  'get_payment_gateway_guide',
  'get_account_setup_guide',
  'get_beneficiary_guide',
  'get_payouts_guide',
  'get_collections_guide',
  'get_verification_guide',
  'get_webhook_guide',
]);

export const zwitchDocsTools: Record<string, unknown> = Object.fromEntries(
  // The MCP client namespaces tool keys with the server name (e.g. "zwitch_search_docs").
  // Match by suffix so we don't depend on exactly how Mastra namespaces them.
  Object.entries(zwitchAllTools).filter(([key]) =>
    [...DOCS_TOOL_NAMES].some(name => key === name || key.endsWith(`_${name}`) || key.endsWith(`.${name}`))
  )
);

console.log(
  `[zwitch-mcp] Loaded ${Object.keys(zwitchAllTools).length} total tools, ` +
  `${Object.keys(zwitchDocsTools).length} docs-only tools available for triage/meeting agents`
);

// ─── Deterministic call helper (no LLM tool-use loop) ────────────────────────

interface MastraMcpToolLike {
  execute: (args: Record<string, unknown>, runtimeCtx?: object) => Promise<unknown>;
}

interface CallToolResultEnvelope {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

const isMcpMatch = (key: string, bareName: string) =>
  key === bareName || key.endsWith(`_${bareName}`) || key.endsWith(`.${bareName}`);

/**
 * Invoke a Zwitch docs MCP tool by its bare name (e.g. 'search_docs') without
 * going through an LLM agent. Mirrors `callRazorpayTool` — used by workflows
 * that need deterministic doc retrieval. Returns `null` if the tool isn't
 * loaded (so callers can degrade gracefully rather than throw).
 */
export async function callZwitchDocsTool<T = unknown>(
  bareName: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  const entry = Object.entries(zwitchDocsTools).find(([key]) => isMcpMatch(key, bareName));
  if (!entry) {
    console.warn(`[zwitch-mcp] tool '${bareName}' not loaded; skipping`);
    return null;
  }
  const [, tool] = entry as [string, MastraMcpToolLike];
  try {
    const result = await tool.execute(args, {});
    if (result !== null && typeof result === 'object' && !('content' in (result as object))) {
      return result as T;
    }
    const envelope = result as CallToolResultEnvelope;
    if (envelope.isError) {
      const text = envelope.content?.find(c => c.type === 'text')?.text ?? JSON.stringify(envelope);
      console.warn(`[zwitch-mcp] tool '${bareName}' returned error: ${text.slice(0, 200)}`);
      return null;
    }
    // Unwrap text-content envelope: parse JSON if it looks like JSON.
    const text = envelope.content?.find(c => c.type === 'text')?.text;
    if (text) {
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
    return (envelope.structuredContent ?? null) as T | null;
  } catch (err) {
    console.warn(`[zwitch-mcp] tool '${bareName}' threw: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Search Zwitch docs (live, via MCP) and normalise the result into the same
 * { publicUrl, text, score } shape the local KB uses, so the support-triage
 * workflow can merge both sources transparently.
 *
 * The Zwitch MCP server returns shapes that have varied over time — we accept
 * a few common ones and best-effort extract URL + snippet. Anything unparseable
 * is dropped (we'd rather skip than feed garbage to the drafter).
 */
export async function searchZwitchDocs(
  query: string,
  opts: { limit?: number } = {},
): Promise<Array<{ publicUrl: string; text: string; score: number; source: string }>> {
  const limit = opts.limit ?? 4;
  const raw = await callZwitchDocsTool<unknown>('search_docs', { query, limit });
  if (!raw) return [];

  // Normalise: accept either { results: [...] } or { docs: [...] } or [...].
  let items: Array<Record<string, unknown>> = [];
  if (Array.isArray(raw)) items = raw as Array<Record<string, unknown>>;
  else if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const candidates = (r.results ?? r.docs ?? r.hits ?? r.items) as unknown;
    if (Array.isArray(candidates)) items = candidates as Array<Record<string, unknown>>;
  }

  return items
    .map(item => {
      const url =
        (item.publicUrl as string) ??
        (item.url as string) ??
        (item.link as string) ??
        '';
      const text =
        (item.snippet as string) ??
        (item.text as string) ??
        (item.body as string) ??
        (item.content as string) ??
        '';
      const score = typeof item.score === 'number' ? (item.score as number) : 0.7;
      const source =
        (item.source as string) ??
        (item.path as string) ??
        (item.id as string) ??
        url;
      return { publicUrl: url, text: String(text).slice(0, 1500), score, source };
    })
    .filter(h => h.publicUrl || h.text)
    .slice(0, limit);
}
