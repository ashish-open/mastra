/**
 * Shared cashfree-mcp client.
 *
 * Cashfree publishes a hosted MCP server at https://mcp.cashfree.com/mcp
 * (HTTP streamable transport). See https://www.cashfree.com/docs/tools-ai/mcp-server.
 *
 * Tool families exposed by the server (selectable via the TOOLS env on the
 * server side — we pass it as a header so we can scope per-request):
 *
 *   pg        — Payment Gateway: orders, payment links, refunds, settlements,
 *               disputes, payment simulation
 *   payouts   — Single/batch transfers, transfer status, Cashgrams
 *   secureid  — Name match, KYC link generation + status
 *
 * IMPORTANT: every tool here is a LIVE-ACTION tool. There is no docs-only
 * subset (unlike zwitch-mcp). Only wire `cashfreeAllTools` into agents that
 * should be allowed to move money / touch customer data — i.e. zeus-agent or
 * a dedicated cashfree agent. Do NOT add to the support-triage / meeting /
 * knowledge bots.
 *
 * Env vars (set in .env):
 *   CASHFREE_APP_ID            — PG/Payouts/SecureID client id (same key used
 *                                by the reco adapter; we reuse it here)
 *   CASHFREE_SECRET_KEY        — PG/Payouts/SecureID client secret
 *   CASHFREE_MCP_URL           — Override the hosted endpoint (optional)
 *   CASHFREE_MCP_ENV           — 'sandbox' | 'production' (default: 'sandbox')
 *   CASHFREE_MCP_TOOLS         — Comma-separated subset, e.g. 'pg,payouts'
 *                                (default: 'pg,payouts,secureid')
 *
 * If the MCP is unreachable at startup we log a warning and return {} so the
 * rest of the app still loads. Agents that depend on this just won't have
 * Cashfree tools until the MCP comes back.
 */

import { MCPClient } from '@mastra/mcp';

const CASHFREE_MCP_URL = process.env.CASHFREE_MCP_URL ?? 'https://mcp.cashfree.com/mcp';
const CASHFREE_MCP_ENV = process.env.CASHFREE_MCP_ENV ?? 'sandbox';
const CASHFREE_MCP_TOOLS = process.env.CASHFREE_MCP_TOOLS ?? 'pg,payouts,secureid';

export const cashfreeMCP = new MCPClient({
  servers: {
    cashfree: {
      url: new URL(CASHFREE_MCP_URL),
      // Default timeout is 3s which is too aggressive for cold starts.
      timeout: 15000,
      requestInit: {
        headers: {
          // Cashfree's standard PG auth headers. The hosted MCP accepts the
          // same client id / secret pair used by the REST API.
          'x-client-id': process.env.CASHFREE_APP_ID ?? '',
          'x-client-secret': process.env.CASHFREE_SECRET_KEY ?? '',
          // Server-side switches; harmless if the server ignores them.
          'x-env': CASHFREE_MCP_ENV,
          'x-tools': CASHFREE_MCP_TOOLS,
        },
      },
    },
  },
});

/**
 * All Cashfree tools (PG + payouts + secureid as per CASHFREE_MCP_TOOLS).
 * Use ONLY in agents authorised to move money. If creds are missing or the
 * MCP is unreachable, we return {} and log — never throw at import time.
 */
export const cashfreeAllTools: Record<string, unknown> = await (async () => {
  if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
    console.warn(
      '[cashfree-mcp] CASHFREE_APP_ID / CASHFREE_SECRET_KEY not set — skipping MCP load. ' +
      'Agents wired to Cashfree will run without those tools.'
    );
    return {} as Record<string, unknown>;
  }
  return cashfreeMCP.listTools().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[cashfree-mcp] ⚠️  Could not load tools (${msg}). Agents will run without Cashfree tools.`);
    return {} as Record<string, unknown>;
  });
})();

console.log(
  `[cashfree-mcp] Loaded ${Object.keys(cashfreeAllTools).length} tools ` +
  `from ${CASHFREE_MCP_URL} (env=${CASHFREE_MCP_ENV}, tools=${CASHFREE_MCP_TOOLS})`
);
for (const key of Object.keys(cashfreeAllTools)) {
  console.log(`  - ${key}`);
}
