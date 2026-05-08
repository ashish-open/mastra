/**
 * Freshdesk Webhook Handler — POST /freshdesk/webhook
 *
 * Register in Freshdesk: Admin → Workflows → Automations → "Ticket Created"
 *   Trigger: New ticket created (or updated)
 *   Action: Trigger Webhook
 *     URL: https://YOUR_NGROK_URL/freshdesk/webhook
 *     Method: POST
 *     Encoding: JSON
 *     Custom headers (optional):
 *       X-Freshdesk-Signature: sha256=<hmac of body using FRESHDESK_WEBHOOK_SECRET>
 *     Content (Simple JSON):
 *       {
 *         "event": "ticket_created",
 *         "ticket_id": "{{ticket.id}}",
 *         "subject": "{{ticket.subject}}",
 *         "status": "{{ticket.status}}"
 *       }
 *
 * Behavior:
 *   - Verifies HMAC if FRESHDESK_WEBHOOK_SECRET is set
 *   - Responds 200 immediately
 *   - Triggers supportTriageWorkflow asynchronously
 */

import type { ApiRoute } from '@mastra/core/server';
import { verifyFreshdeskWebhook } from '../tools/freshdesk-tool.js';

interface FreshdeskWebhookPayload {
  event?: string;
  ticket_id?: string | number;
  subject?: string;
  status?: string | number;
  [key: string]: unknown;
}

async function processFreshdeskWebhook(payload: FreshdeskWebhookPayload, mastra: unknown): Promise<void> {
  const ticketIdRaw = payload.ticket_id ?? (payload as { id?: string | number }).id;
  if (!ticketIdRaw) {
    console.error('[freshdesk-webhook] No ticket_id in payload:', JSON.stringify(payload));
    return;
  }

  const ticketId = typeof ticketIdRaw === 'string' ? parseInt(ticketIdRaw, 10) : ticketIdRaw;
  if (Number.isNaN(ticketId)) {
    console.error('[freshdesk-webhook] Invalid ticket_id:', ticketIdRaw);
    return;
  }

  console.log(`[freshdesk-webhook] Triggering triage for ticket ${ticketId} (event=${payload.event ?? 'unknown'})`);

  const m = mastra as {
    getWorkflow: (id: string) => {
      createRun: (opts?: { runId?: string }) => Promise<{ startAsync: (opts: { inputData: unknown }) => Promise<void> }>;
    } | undefined;
  };
  const workflow = m.getWorkflow('supportTriageWorkflow');
  if (!workflow) {
    console.error('[freshdesk-webhook] supportTriageWorkflow not found in Mastra instance');
    return;
  }

  const run = await workflow.createRun();
  await run.startAsync({
    inputData: { ticketId, autoSendReply: false },
  });

  console.log(`[freshdesk-webhook] Triage workflow triggered for ticket ${ticketId}`);
}

export const freshdeskWebhookRoute: ApiRoute = {
  path: '/freshdesk/webhook',
  method: 'POST',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: ({ mastra }): any => Promise.resolve(async (c: any) => {
    const rawBody = await c.req.text();

    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value: string, key: string) => {
      headers[key.toLowerCase()] = value;
    });

    if (!verifyFreshdeskWebhook(rawBody, headers)) {
      console.warn('[freshdesk-webhook] Signature verification FAILED — rejecting');
      return c.json({ error: 'Invalid signature' }, 401);
    }

    let payload: FreshdeskWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as FreshdeskWebhookPayload;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    void processFreshdeskWebhook(payload, mastra).catch(err => {
      console.error('[freshdesk-webhook] Background processing error:', err);
    });

    return c.json({ received: true });
  }),
};
