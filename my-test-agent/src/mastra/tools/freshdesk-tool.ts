/**
 * Freshdesk Tools — REST v2 wrapper for the Support Triage Agent
 *
 * Auth: Basic base64(apiKey + ":X") — the "X" padding is mandatory per Freshdesk docs.
 * Base: https://{cleanDomain}/api/v2
 *
 * Required env vars:
 *   FRESHDESK_DOMAIN          — full URL or subdomain (e.g. "openfin.freshdesk.com")
 *   FRESHDESK_API_KEY         — admin API key (used by the bot identity)
 *   FRESHDESK_WEBHOOK_SECRET  — optional HMAC-SHA256 secret for webhook verification
 *
 * Practices:
 *   ✓ Retry-safe fetch (429 honors Retry-After, 5xx with backoff)
 *   ✓ HMAC-SHA256 webhook verification
 *   ✓ Request body sanitized — \n converted to <br> for HTML reply bodies
 */

import { createTool } from '@mastra/core/tools';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  MAILBOX_TO_GROUP,
  EMAIL_TO_GROUP,
  GROUP_NAME_BY_ID,
  PEG_DEFAULT_GROUP_ID,
  FRESHDESK_GROUPS,
} from './freshdesk-routing.js';

// ─── Config ───────────────────────────────────────────────────────────────────

function cleanDomain(): string {
  const raw = process.env.FRESHDESK_DOMAIN;
  if (!raw) throw new Error('FRESHDESK_DOMAIN env var is not set');
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function freshdeskBase(): string {
  return `https://${cleanDomain()}/api/v2`;
}

export function freshdeskAuthHeader(): string {
  const key = process.env.FRESHDESK_API_KEY;
  if (!key) throw new Error('FRESHDESK_API_KEY env var is not set');
  return `Basic ${Buffer.from(`${key}:X`).toString('base64')}`;
}

function jsonHeaders(): Record<string, string> {
  return {
    Authorization: freshdeskAuthHeader(),
    'Content-Type': 'application/json',
  };
}

// ─── Retry-safe fetch ─────────────────────────────────────────────────────────

export async function freshdeskFetch(url: string, options: RequestInit, maxAttempts = 5): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, options);

    // Retry on 429 (rate limit) and 5xx
    if (response.status === 429) {
      const wait = parseInt(response.headers.get('Retry-After') ?? '5', 10);
      console.warn(`[freshdesk] 429 rate limit, retrying in ${wait}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, (wait + 1) * 1000));
      continue;
    }
    if (response.status >= 500 && attempt < maxAttempts) {
      const wait = Math.min(2 ** attempt, 30);
      console.warn(`[freshdesk] ${response.status}, retrying in ${wait}s`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }

    return response;
  }
  throw new Error(`[freshdesk] Max retry attempts (${maxAttempts}) reached for ${url}`);
}

// ─── Webhook verification (HMAC-SHA256) ───────────────────────────────────────

export function verifyFreshdeskWebhook(rawBody: string, headers: Record<string, string | undefined>): boolean {
  const secret = process.env.FRESHDESK_WEBHOOK_SECRET;
  // If no secret configured, skip verification (dev mode) — log warning
  if (!secret) {
    console.warn('[freshdesk] FRESHDESK_WEBHOOK_SECRET not set — skipping verification (DEV ONLY)');
    return true;
  }

  const sig = headers['x-freshdesk-signature'] ?? headers['X-Freshdesk-Signature'];
  if (!sig) {
    console.error('[freshdesk] Missing x-freshdesk-signature header');
    return false;
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const recv = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;

  try {
    const a = Buffer.from(recv, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Tool: Get Ticket (with conversations) ────────────────────────────────────

export const getFreshdeskTicket = createTool({
  id: 'get-freshdesk-ticket',
  description:
    'Fetches a Freshdesk ticket by ID, including the requester info and the full conversation thread. Use this to read a ticket before classifying or replying.',
  inputSchema: z.object({
    ticketId: z.number().describe('Freshdesk ticket ID'),
  }),
  execute: async ({ ticketId }) => {
    const base = freshdeskBase();

    const [ticketRes, convRes] = await Promise.all([
      freshdeskFetch(`${base}/tickets/${ticketId}?include=requester,stats`, { headers: jsonHeaders() }),
      freshdeskFetch(`${base}/tickets/${ticketId}/conversations`, { headers: jsonHeaders() }),
    ]);

    if (!ticketRes.ok) throw new Error(`Get ticket failed (${ticketRes.status}): ${await ticketRes.text()}`);
    if (!convRes.ok) throw new Error(`Get conversations failed (${convRes.status}): ${await convRes.text()}`);

    const ticket = (await ticketRes.json()) as Record<string, unknown>;
    const conversations = (await convRes.json()) as Array<Record<string, unknown>>;

    // Resolve the canonical group from the inbound mailbox (email_config_id).
    // This is the most reliable routing signal — it matches Freshdesk's own config.
    const emailConfigId = ticket.email_config_id as number | null;
    const toEmail = ((ticket.to_emails as string[]) ?? []).map(e => e.toLowerCase());
    let mailboxGroupId: number | null = null;
    if (emailConfigId && MAILBOX_TO_GROUP[emailConfigId]) {
      mailboxGroupId = MAILBOX_TO_GROUP[emailConfigId];
    } else {
      for (const e of toEmail) {
        if (EMAIL_TO_GROUP[e]) { mailboxGroupId = EMAIL_TO_GROUP[e]; break; }
      }
    }
    const resolvedGroupId = (ticket.group_id as number | null) ?? mailboxGroupId ?? PEG_DEFAULT_GROUP_ID;
    const resolvedGroupName = GROUP_NAME_BY_ID.get(resolvedGroupId) ?? 'Product Experience & Growth';

    return {
      id: ticket.id as number,
      subject: ticket.subject as string,
      description: ticket.description_text as string,
      status: ticket.status as number,
      priority: ticket.priority as number,
      tags: (ticket.tags as string[]) ?? [],
      groupId: ticket.group_id as number | null,
      responderId: ticket.responder_id as number | null,
      requester: ticket.requester ?? null,
      // ─── Routing signals (derived) ─────────────────────────────────
      emailConfigId,
      toEmails: toEmail,
      mailboxGroupId,
      resolvedGroupId,
      resolvedGroupName,
      // ───────────────────────────────────────────────────────────────
      createdAt: ticket.created_at as string,
      updatedAt: ticket.updated_at as string,
      conversations: conversations.map(c => ({
        id: c.id as number,
        bodyText: c.body_text as string,
        fromEmail: c.from_email as string,
        private: c.private as boolean,
        incoming: c.incoming as boolean,
        createdAt: c.created_at as string,
      })),
    };
  },
});

// ─── Tool: List Recent Tickets ────────────────────────────────────────────────

export const listFreshdeskTickets = createTool({
  id: 'list-freshdesk-tickets',
  description:
    'Lists recent Freshdesk tickets, optionally filtered by status. Useful for batch triage or finding similar past tickets.',
  inputSchema: z.object({
    status: z
      .enum(['open', 'pending', 'resolved', 'closed', 'all_unresolved'])
      .optional()
      .describe('Filter by status. all_unresolved = open + pending + custom unresolved statuses.'),
    perPage: z.number().min(1).max(100).default(30),
    page: z.number().min(1).default(1),
  }),
  execute: async ({ status, perPage, page }) => {
    const statusMap: Record<string, number[]> = {
      open: [2],
      pending: [3],
      resolved: [4],
      closed: [5],
      all_unresolved: [2, 3, 6, 7, 8, 11, 15, 21],
    };

    const url = new URL(`${freshdeskBase()}/tickets`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('order_by', 'updated_at');
    url.searchParams.set('order_type', 'desc');

    const res = await freshdeskFetch(url.toString(), { headers: jsonHeaders() });
    if (!res.ok) throw new Error(`List tickets failed (${res.status}): ${await res.text()}`);

    let tickets = (await res.json()) as Array<Record<string, unknown>>;
    if (status && statusMap[status]) {
      const allowed = new Set(statusMap[status]);
      tickets = tickets.filter(t => allowed.has(t.status as number));
    }

    return {
      count: tickets.length,
      tickets: tickets.map(t => ({
        id: t.id as number,
        subject: t.subject as string,
        status: t.status as number,
        priority: t.priority as number,
        tags: (t.tags as string[]) ?? [],
        updatedAt: t.updated_at as string,
      })),
    };
  },
});

// ─── Tool: Post Reply (public — sent to customer) ─────────────────────────────

export const replyToFreshdeskTicket = createTool({
  id: 'reply-to-freshdesk-ticket',
  description:
    'Posts a PUBLIC reply to a Freshdesk ticket — the customer will receive this email. ⚠️ Use only when the response is reviewed and approved. Prefer addPrivateNote for AI drafts pending human review.',
  inputSchema: z.object({
    ticketId: z.number(),
    body: z.string().describe('Reply body. Plain text — newlines are auto-converted to <br>.'),
    cc: z.array(z.string()).optional().describe('Email addresses to CC'),
  }),
  execute: async ({ ticketId, body, cc }) => {
    const htmlBody = body.replace(/\n/g, '<br>');
    const payload: Record<string, unknown> = { body: htmlBody };
    if (cc && cc.length > 0) payload.cc_emails = cc;

    const res = await freshdeskFetch(`${freshdeskBase()}/tickets/${ticketId}/reply`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Reply failed (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as { id: number };
    console.log(`[freshdesk] Replied to ticket ${ticketId} (conversation ${data.id})`);
    return { conversationId: data.id, ticketId };
  },
});

// ─── Tool: Add Private Note (internal — not visible to customer) ─────────────

export const addFreshdeskPrivateNote = createTool({
  id: 'add-freshdesk-private-note',
  description:
    'Adds a PRIVATE internal note to a Freshdesk ticket — only visible to support agents, not to the customer. Use this to leave AI-drafted reply suggestions for human review, or to record classification reasoning.',
  inputSchema: z.object({
    ticketId: z.number(),
    body: z.string().describe('Note body. Plain text — newlines are auto-converted to <br>.'),
    notifyAgentIds: z.array(z.number()).optional().describe('Freshdesk agent IDs to notify about this note'),
  }),
  execute: async ({ ticketId, body, notifyAgentIds }) => {
    const htmlBody = body.replace(/\n/g, '<br>');
    const payload: Record<string, unknown> = { body: htmlBody, private: true };
    if (notifyAgentIds && notifyAgentIds.length > 0) payload.notify_emails = [];

    const res = await freshdeskFetch(`${freshdeskBase()}/tickets/${ticketId}/notes`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Add note failed (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as { id: number };
    console.log(`[freshdesk] Added private note to ticket ${ticketId} (conversation ${data.id})`);
    return { conversationId: data.id, ticketId };
  },
});

// ─── Tool: Update Ticket (route, tag, change status) ─────────────────────────

export const updateFreshdeskTicket = createTool({
  id: 'update-freshdesk-ticket',
  description:
    'Updates a Freshdesk ticket — change status, priority, group (team), responder (assignee), or add tags. Use this to route tickets to the right team after classification.',
  inputSchema: z.object({
    ticketId: z.number(),
    status: z
      .enum(['open', 'pending', 'resolved', 'closed', 'waiting_on_customer', 'waiting_on_third_party'])
      .optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    groupId: z.number().optional().describe('Freshdesk group_id to route the ticket to'),
    responderId: z.number().optional().describe('Freshdesk agent_id to assign'),
    addTags: z.array(z.string()).optional().describe('Tags to ADD (merged with existing tags)'),
  }),
  execute: async ({ ticketId, status, priority, groupId, responderId, addTags }) => {
    const statusMap = {
      open: 2,
      pending: 3,
      resolved: 4,
      closed: 5,
      waiting_on_customer: 6,
      waiting_on_third_party: 7,
    };
    const priorityMap = { low: 1, medium: 2, high: 3, urgent: 4 };

    const payload: Record<string, unknown> = {};
    if (status) payload.status = statusMap[status];
    if (priority) payload.priority = priorityMap[priority];
    if (groupId !== undefined) payload.group_id = groupId;
    if (responderId !== undefined) payload.responder_id = responderId;

    // Tag merging requires fetching existing tags first
    if (addTags && addTags.length > 0) {
      const existing = await freshdeskFetch(`${freshdeskBase()}/tickets/${ticketId}`, {
        headers: jsonHeaders(),
      });
      if (existing.ok) {
        const t = (await existing.json()) as { tags?: string[] };
        const merged = Array.from(new Set([...(t.tags ?? []), ...addTags]));
        payload.tags = merged;
      } else {
        payload.tags = addTags;
      }
    }

    if (Object.keys(payload).length === 0) {
      return { ticketId, updated: false, message: 'No fields to update' };
    }

    const res = await freshdeskFetch(`${freshdeskBase()}/tickets/${ticketId}`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Update ticket failed (${res.status}): ${await res.text()}`);

    console.log(`[freshdesk] Updated ticket ${ticketId}:`, Object.keys(payload).join(', '));
    return { ticketId, updated: true, fields: Object.keys(payload) };
  },
});

// ─── Tool: Lookup Group (local — uses cached routing data, no API call) ─────

export const lookupFreshdeskGroup = createTool({
  id: 'lookup-freshdesk-group',
  description:
    'Looks up a Freshdesk group by name fragment from the cached routing table. Use this to find a valid group_id when you need to suggest a re-route. Returns matching groups with their IDs. ALWAYS use this instead of guessing group names.',
  inputSchema: z.object({
    nameContains: z.string().describe('Substring to match against group names (case-insensitive)'),
  }),
  execute: async ({ nameContains }) => {
    const q = nameContains.toLowerCase();
    const matches = FRESHDESK_GROUPS.filter(g => g.name.toLowerCase().includes(q));
    return {
      query: nameContains,
      count: matches.length,
      matches: matches.map(g => ({ id: g.id, name: g.name })),
    };
  },
});

// ─── Tool: List Groups (for routing) ─────────────────────────────────────────

export const listFreshdeskGroups = createTool({
  id: 'list-freshdesk-groups',
  description:
    'Lists all Freshdesk groups (teams). Use this to discover which group_id to route a ticket to (e.g. "Refunds Team", "API Support", "KYC Ops").',
  inputSchema: z.object({}),
  execute: async () => {
    const res = await freshdeskFetch(`${freshdeskBase()}/admin/groups?per_page=100`, {
      headers: jsonHeaders(),
    });
    if (!res.ok) throw new Error(`List groups failed (${res.status}): ${await res.text()}`);

    const groups = (await res.json()) as Array<Record<string, unknown>>;
    return {
      count: groups.length,
      groups: groups.map(g => ({
        id: g.id as number,
        name: g.name as string,
        description: g.description as string | null,
        agentIds: (g.agent_ids as number[]) ?? [],
      })),
    };
  },
});
