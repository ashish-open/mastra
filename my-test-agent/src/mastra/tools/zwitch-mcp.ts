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
