/**
 * Seed Razorpay test-mode payment links via the official MCP server.
 *
 * Razorpay test accounts start empty. To exercise the reco flow against real
 * data you need actual payments → which need a settlement cycle (T+2 even in
 * test mode) → which produces recon data the MCP can return.
 *
 * This script automates step 1: bulk-creating payment links. Each one returns
 * a `short_url` you (or a teammate) can open and complete with a test card
 * `4111 1111 1111 1111` (any future expiry, CVV 100). Razorpay then queues
 * the settlement.
 *
 * Usage:
 *   RAZORPAY_KEY_ID=rzp_test_xxx \
 *   RAZORPAY_KEY_SECRET=xxx \
 *   pnpm tsx scripts/seed-razorpay-test-data.ts --count 10
 *
 * Or programmatically via the /reco/mcp/razorpay/seed endpoint (added below).
 *
 * Notes:
 *   - Uses test mode only. Will refuse to run against `rzp_live_*` keys.
 *   - Amounts randomized between ₹100 and ₹5000 to make the recon data
 *     non-trivial (variable batch sums catch matcher edge cases).
 *   - Each link is tagged with reference_id `OPENARC_SEED_<timestamp>_<n>`
 *     so seeded data can be cleaned later if needed.
 */

import { McpConnector } from '../src/mastra/reconciliation/connectors/mcp-connector.js';

interface SeedResult {
  index: number;
  amountPaise: number;
  paymentLinkId?: string;
  shortUrl?: string;
  error?: string;
}

async function seedRazorpayPaymentLinks(count: number): Promise<SeedResult[]> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET env vars are required.');
  }
  if (keyId.startsWith('rzp_live_')) {
    throw new Error(
      'Refusing to seed against a LIVE Razorpay key (rzp_live_*). ' +
      'Use a test key (rzp_test_*) for this script.'
    );
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const mcp = new McpConnector({
    url: process.env.RAZORPAY_MCP_URL ?? 'https://mcp.razorpay.com/mcp',
    headers: { Authorization: `Basic ${auth}` },
    clientName: 'openarc-seed-script',
  });

  const results: SeedResult[] = [];
  const seedBatchId = `OPENARC_SEED_${Date.now()}`;

  try {
    for (let i = 1; i <= count; i++) {
      // ₹100 to ₹5,000, varied so settlement sums aren't suspiciously uniform.
      const amountPaise = (100 + Math.floor(Math.random() * 4900)) * 100;
      try {
        const result = await mcp.callTool('create_payment_link', {
          amount: amountPaise,
          currency: 'INR',
          description: `OpenArc test seed ${i}/${count}`,
          reference_id: `${seedBatchId}_${i}`,
          // Razorpay also accepts customer + notify keys; we omit them so
          // the link is anonymous-payable (good for demo card runs).
          accept_partial: false,
          // Expire in 24h so seeded links don't litter the account.
          expire_by: Math.floor(Date.now() / 1000) + 86400,
        });

        if (result.isError) {
          results.push({ index: i, amountPaise, error: JSON.stringify(result.content).slice(0, 200) });
          continue;
        }

        const payload = result.content as { id?: string; short_url?: string };
        results.push({
          index: i,
          amountPaise,
          paymentLinkId: payload.id,
          shortUrl: payload.short_url,
        });
      } catch (e) {
        results.push({ index: i, amountPaise, error: (e as Error).message });
      }
    }
  } finally {
    await mcp.close();
  }

  return results;
}

// ─── CLI entry point ────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const countArg = process.argv.findIndex(a => a === '--count');
  const count = countArg >= 0 ? parseInt(process.argv[countArg + 1], 10) : 10;
  if (!Number.isFinite(count) || count < 1 || count > 100) {
    console.error('--count must be between 1 and 100');
    process.exit(1);
  }

  console.log(`Creating ${count} Razorpay test payment links…`);
  seedRazorpayPaymentLinks(count)
    .then(results => {
      const ok = results.filter(r => !r.error);
      const failed = results.filter(r => r.error);
      console.log(`\n✓ ${ok.length} created, ✗ ${failed.length} failed\n`);
      for (const r of ok) {
        console.log(`  [${r.index}] ₹${(r.amountPaise / 100).toFixed(2).padStart(8)}  ${r.shortUrl}`);
      }
      if (failed.length > 0) {
        console.log('\nFailures:');
        for (const r of failed) console.log(`  [${r.index}] ${r.error}`);
      }
      console.log('\nNext: open each short_url and pay with test card 4111 1111 1111 1111');
      console.log('       (any future expiry, CVV 100). Settlements appear after T+2 in test mode.');
    })
    .catch(err => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}

export { seedRazorpayPaymentLinks };
