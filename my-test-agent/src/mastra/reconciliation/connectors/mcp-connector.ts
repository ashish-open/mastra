/**
 * Generic MCP Connector — talks to any Model Context Protocol server over
 * Streamable HTTP transport.
 *
 * This is the first "connector" (per the new 3-layer architecture):
 *   - Connectors handle the protocol (MCP, REST, AA, DB, file).
 *   - Connections are user-configured instances (e.g. "Live Razorpay MID").
 *   - Flows reference connections by id.
 *
 * For now we use it directly from inside `pg-razorpay` adapter as a
 * drop-in replacement for the previous raw `fetch()` REST call. Later we'll
 * wrap it behind the Connection registry so any provider can be wired
 * without code.
 *
 * Usage:
 *   const mcp = new McpConnector({
 *     url: 'https://mcp.razorpay.com/mcp',
 *     headers: { Authorization: `Basic ${base64(key + ':' + secret)}` },
 *   });
 *   await mcp.connect();
 *   const result = await mcp.callTool('fetch_settlement_recon_details',
 *                                     { year: 2026, month: 5, day: 13, count: 100 });
 *   await mcp.close();
 *
 * Caller is responsible for shape-transforming the result into NormalizedTxn[]
 * — that mapping is provider-specific and lives in the adapter file.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface McpConnectorConfig {
  /** Full URL to the MCP server's HTTP endpoint, e.g. https://mcp.razorpay.com/mcp */
  url: string;
  /** Optional HTTP headers — Authorization goes here. */
  headers?: Record<string, string>;
  /** Client identification surfaced to the server's logs. */
  clientName?: string;
  clientVersion?: string;
}

export interface ToolCallResult {
  /** Whatever the tool returned — usually a JSON-serializable object. */
  content: unknown;
  /** Whether the server reported the call as an error. */
  isError: boolean;
}

export class McpConnector {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private readonly config: McpConnectorConfig;

  constructor(config: McpConnectorConfig) {
    this.config = config;
  }

  /**
   * Establish the MCP session. Idempotent — safe to call multiple times.
   * Throws on auth failure or unreachable server so the caller can surface
   * a clear "your connection is broken, fix it" error to the operator.
   */
  async connect(): Promise<void> {
    if (this.client) return;

    // The Streamable HTTP transport accepts a `requestInit` that's merged into
    // every fetch — that's where we inject the Authorization header. The
    // Razorpay docs require Basic auth with base64(key:secret).
    this.transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
    });

    this.client = new Client(
      {
        name: this.config.clientName ?? 'openarc-reco',
        version: this.config.clientVersion ?? '1.0.0',
      },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    console.log(`[mcp] connected to ${this.config.url}`);
  }

  /**
   * Lists the tools the server exposes. Useful for the UI "Test connection"
   * button and for debugging which tools a particular MCP supports.
   */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    await this.connect();
    const res = await this.client!.listTools();
    return res.tools.map(t => ({ name: t.name, description: t.description }));
  }

  /**
   * Invoke a tool with arguments. Server returns content blocks of various
   * types; we return whatever's most useful as a typed object.
   *
   * Razorpay's MCP wraps API responses as `text` blocks containing JSON.
   * We try to parse those back into objects — saves every caller from
   * doing the same JSON.parse dance.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    await this.connect();
    const res = await this.client!.callTool({ name, arguments: args });
    const isError = res.isError === true;

    // The MCP SDK returns `content: ContentBlock[]`. Each block is one of:
    //   { type: 'text', text: '<string>' }
    //   { type: 'image', ... }
    //   { type: 'resource', ... }
    // For data tools (Razorpay's settlements etc.) the payload is a single
    // text block containing JSON. Try to parse it; fall back to raw content
    // for tools that return text or anything unexpected.
    const content = Array.isArray(res.content) ? res.content : [];
    if (content.length === 1 && (content[0] as { type?: string }).type === 'text') {
      const text = (content[0] as { text: string }).text;
      try {
        return { content: JSON.parse(text), isError };
      } catch {
        return { content: text, isError };
      }
    }
    return { content, isError };
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch (e) {
      console.warn('[mcp] close error:', (e as Error).message);
    } finally {
      this.client = null;
      this.transport = null;
    }
  }
}
