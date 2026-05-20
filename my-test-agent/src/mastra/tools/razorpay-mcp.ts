/**
 * Shared razorpay-mcp client.
 *
 * Mirrors zwitch-mcp / cashfree-mcp: a single `@mastra/mcp` MCPClient pointing
 * at https://mcp.razorpay.com/mcp. Exposes the loaded tools in three shapes:
 *
 *   1. razorpayAllTools       — every tool the server advertised, namespaced
 *                               (`razorpay_<name>`). Spread into an agent's
 *                               `tools: { ... }` for agentic use.
 *
 *   2. razorpayRecoTools      — explicit allow-list of read-only data fetches
 *                               safe for the reconciliation workflow. Add
 *                               new entries to RAZORPAY_RECO_TOOL_NAMES below.
 *
 *   3. callRazorpayTool()     — workflow-facing helper. Looks up a tool by
 *                               its bare name (without the `razorpay_`
 *                               prefix), calls `.execute()` deterministically,
 *                               unwraps the MCP CallToolResult envelope, and
 *                               returns the parsed JSON. No LLM in the loop.
 *
 * Why both an allow-list AND a per-call helper:
 *   - The allow-list lets future agents pull a curated subset without ever
 *     touching write-action tools (refunds, captures, etc.).
 *   - The per-call helper lets workflow code stay terse and deterministic:
 *     `await callRazorpayTool('fetch_settlement_recon_details', { year, month, day })`.
 *   - Both go through the SAME MCPClient session — one auth, one transport,
 *     one place to debug.
 *
 * Auth: Razorpay uses HTTP Basic with `${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`.
 *
 * Env vars:
 *   RAZORPAY_KEY_ID            — required (else MCP is disabled, REST fallback used)
 *   RAZORPAY_KEY_SECRET        — required
 *   RAZORPAY_MCP_URL           — override hosted endpoint (default mcp.razorpay.com/mcp)
 *
 * Failure semantics: if creds are missing or the server is unreachable at
 * startup, we log + return `{}`. The reco workflow has a REST fallback for
 * the money-critical settlement fetch, so MCP outages don't block reconciliation.
 */

import { MCPClient } from '@mastra/mcp';

const RAZORPAY_MCP_URL = process.env.RAZORPAY_MCP_URL ?? 'https://mcp.razorpay.com/mcp';

function basicAuthHeader(): string | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) return null;
  return `Basic ${Buffer.from(`${keyId}:${secret}`).toString('base64')}`;
}

const auth = basicAuthHeader();

export const razorpayMCP = auth
  ? new MCPClient({
      servers: {
        razorpay: {
          url: new URL(RAZORPAY_MCP_URL),
          // Default timeout is 3s; raise so initial listTools() doesn't error on cold starts.
          timeout: 15000,
          requestInit: {
            headers: { Authorization: auth },
          },
        },
      },
    })
  : null;

// MCP tools have a Mastra-tool shape with `execute(input, context)`. We type
// the relevant bits locally to avoid coupling to @mastra/core internals.
type MastraToolLike = {
  execute: (input: unknown, context?: unknown) => Promise<unknown>;
};

/**
 * All Razorpay tools as a Mastra-tool-record, keys namespaced
 * `razorpay_<toolName>`. Empty record if MCP is disabled / unreachable.
 */
export const razorpayAllTools: Record<string, MastraToolLike> = razorpayMCP
  ? ((await razorpayMCP.listTools().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[razorpay-mcp] ⚠️  Could not load tools (${msg}). Reco workflow will use REST fallback.`);
      return {};
    })) as Record<string, MastraToolLike>)
  : (() => {
      console.warn(
        '[razorpay-mcp] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — MCP disabled. ' +
        'Reco workflow will use REST fallback when possible.'
      );
      return {} as Record<string, MastraToolLike>;
    })();

console.log(
  `[razorpay-mcp] Loaded ${Object.keys(razorpayAllTools).length} tools from ${RAZORPAY_MCP_URL}`
);
for (const key of Object.keys(razorpayAllTools)) {
  console.log(`  - ${key}`);
}

// ─── Allow-listing ───────────────────────────────────────────────────────────

/**
 * Bare tool names (without the `razorpay_` prefix) the reconciliation workflow
 * is allowed to call. Add new entries here as the workflow expands — but
 * STRICTLY read-only ones. No payments / refunds / settlements_create.
 */
export const RAZORPAY_RECO_TOOL_NAMES = [
  'fetch_settlement_recon_details',
  // 'fetch_payment',     // uncomment when fuzzy matcher needs per-payment lookups
  // 'fetch_order',
] as const;

const isMatch = (key: string, bareName: string) =>
  key === bareName ||
  key.endsWith(`_${bareName}`) ||
  key.endsWith(`.${bareName}`);

function pickByBareName(bareNames: readonly string[]): Record<string, MastraToolLike> {
  return Object.fromEntries(
    Object.entries(razorpayAllTools).filter(([key]) =>
      bareNames.some(n => isMatch(key, n))
    )
  );
}

/**
 * Curated Razorpay tools safe for the reconciliation workflow. The workflow
 * controls exactly which tools are exposed by editing
 * RAZORPAY_RECO_TOOL_NAMES — nothing outside the list can be called.
 */
export const razorpayRecoTools: Record<string, MastraToolLike> = pickByBareName(
  RAZORPAY_RECO_TOOL_NAMES,
);

// ─── Workflow-facing helper ──────────────────────────────────────────────────

/** Shape Razorpay's MCP returns when there's no `structuredContent`. */
interface CallToolResultEnvelope {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/**
 * Call a Razorpay MCP tool by its bare name (without the `razorpay_` prefix).
 * Designed for deterministic workflow code: no LLM, no tool-selection step.
 *
 * The MCP client either returns `structuredContent` (already a JS object) or
 * the raw CallToolResult envelope `{ content: [{type:'text', text:'<json>'}] }`.
 * We unwrap both. If the server signals an error, we throw with the message.
 *
 * Throws if the tool isn't loaded — that's a config bug, not a runtime
 * condition, so it should fail loudly.
 */
export async function callRazorpayTool<T = unknown>(
  bareName: string,
  args: Record<string, unknown>,
): Promise<T> {
  const entry = Object.entries(razorpayAllTools).find(([key]) => isMatch(key, bareName));
  if (!entry) {
    throw new Error(
      `Razorpay MCP tool '${bareName}' not loaded. ` +
      `Available: ${Object.keys(razorpayAllTools).join(', ') || '(none)'}`
    );
  }
  const [, tool] = entry;
  const result = await tool.execute(args, {});

  // structuredContent case — tool returned a typed object directly.
  // Heuristic: if the result doesn't look like a CallToolResult envelope, it's structured.
  if (result !== null && typeof result === 'object' && !('content' in (result as object))) {
    return result as T;
  }

  // CallToolResult envelope. Check for error first.
  const envelope = result as CallToolResultEnvelope;
  if (envelope.isError) {
    const text = envelope.content?.find(c => c.type === 'text')?.text ?? JSON.stringify(envelope);
    throw new Error(`Razorpay MCP tool '${bareName}' returned error: ${text.slice(0, 300)}`);
  }

  // Single text block → try JSON.parse. Multi-block → return as-is.
  const blocks = envelope.content ?? [];
  if (blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string') {
    try {
      return JSON.parse(blocks[0].text) as T;
    } catch {
      return blocks[0].text as unknown as T;
    }
  }
  return envelope as unknown as T;
}
