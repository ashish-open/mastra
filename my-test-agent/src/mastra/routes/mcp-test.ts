/**
 * MCP connection test endpoint.
 *
 *   GET /reco/mcp/razorpay/test
 *     - Reads RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET from env
 *     - Connects to the Razorpay MCP server
 *     - Lists tools (proves the connection works + auth is valid)
 *     - Returns the tool catalog
 *
 * This is a stepping stone to the proper Connections UI. Once the Connection
 * registry lands, this same test logic moves behind /connections/:id/test
 * and accepts any connection id rather than env-only Razorpay.
 *
 * Intentionally NOT calling fetch_settlement_recon_details here — that needs
 * a date and we want a fast "is the connection healthy" check.
 */

import type { ApiRoute } from '@mastra/core/server';
import { McpConnector } from '../reconciliation/connectors/mcp-connector.js';
import { seedRazorpayPaymentLinks } from '../../../scripts/seed-razorpay-test-data.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoCtx = any;

export const recoMcpRazorpayTestRoute: ApiRoute = {
  path: '/reco/mcp/razorpay/test',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: HonoCtx) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return c.json({
        ok: false,
        error: 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET env vars are required.',
      }, 400);
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const mcpUrl = process.env.RAZORPAY_MCP_URL ?? 'https://mcp.razorpay.com/mcp';

    const mcp = new McpConnector({
      url: mcpUrl,
      headers: { Authorization: `Basic ${auth}` },
      clientName: 'openarc-reco-test',
    });

    try {
      const start = Date.now();
      const tools = await mcp.listTools();
      const ms = Date.now() - start;
      return c.json({
        ok: true,
        mcpUrl,
        latencyMs: ms,
        toolCount: tools.length,
        // Surface the recon-related tools first since that's what reco uses.
        tools: tools
          .filter(t => /settlement|payment|refund/i.test(t.name))
          .map(t => ({ name: t.name, description: t.description }))
          .slice(0, 20),
      });
    } catch (e) {
      return c.json({
        ok: false,
        mcpUrl,
        error: (e as Error).message,
      }, 502);
    } finally {
      await mcp.close();
    }
  }),
};

// ─── POST /reco/mcp/razorpay/seed ───────────────────────────────────────────
//
// Bulk-creates Razorpay test payment links via MCP.
//
// Body: { count?: number }   (default 10, max 50)
//
// Returns: { ok, requested, created, failed, links: [{ index, amountPaise,
//            paymentLinkId, shortUrl }], failures }
//
// Refuses to run if RAZORPAY_KEY_ID starts with 'rzp_live_' — production
// money is not for seeding.
//
// After the call:
//   1. Each short_url in the response is payable via test card
//      4111 1111 1111 1111 (any future expiry, CVV 100).
//   2. Razorpay processes the payment.
//   3. Settlement happens on the merchant's cycle (T+2 in test mode).
//   4. Once settled, the recon flow's "Fetch from API" path will return
//      real data for that date.

export const recoMcpRazorpaySeedRoute: ApiRoute = {
  path: '/reco/mcp/razorpay/seed',
  method: 'POST',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: HonoCtx) => {
    let body: { count?: number };
    try { body = await c.req.json(); } catch { body = {}; }
    const count = Math.min(Math.max(Number(body.count ?? 10), 1), 50);

    try {
      const results = await seedRazorpayPaymentLinks(count);
      const created = results.filter(r => !r.error);
      const failed = results.filter(r => r.error);
      return c.json({
        ok: failed.length === 0,
        requested: count,
        created: created.length,
        failed: failed.length,
        links: created.map(r => ({
          index: r.index,
          amountPaise: r.amountPaise,
          paymentLinkId: r.paymentLinkId,
          shortUrl: r.shortUrl,
        })),
        failures: failed.map(r => ({ index: r.index, error: r.error })),
        instructions:
          'Open each shortUrl and pay with test card 4111 1111 1111 1111 ' +
          '(any future expiry, CVV 100). Settlements show in the recon ' +
          'API after Razorpay\'s settlement cycle (T+2 in test mode).',
      });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  }),
};
