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

/**
 * Plain helper: fetch a Freshdesk ticket + full conversation thread + derived
 * routing signals. Same shape as the `get-freshdesk-ticket` tool result. Exists
 * separately so the workflow can call it deterministically (without going
 * through the LLM tool-use loop) — important for computing LATEST_INCOMING
 * before invoking the agent.
 */
export async function fetchFreshdeskTicket(ticketId: number) {
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
}

export type FreshdeskTicketDetail = Awaited<ReturnType<typeof fetchFreshdeskTicket>>;

/**
 * Find the latest INCOMING (customer-sent, non-private) conversation entry.
 * Returns `{ id: 'description', at: ticket.createdAt }` when no incoming reply
 * exists — i.e. only the original ticket description is visible to triage.
 *
 * The workflow uses this to deterministically decide Mode A/B/C BEFORE calling
 * the LLM. Doing this in the agent prompt has proved unreliable: with a
 * non-empty working memory, the model frequently short-circuits to Mode C
 * without re-checking conversations[].
 */
export function findLatestIncoming(ticket: FreshdeskTicketDetail): { id: string; at: string } {
  const incoming = ticket.conversations.filter(c => c.incoming === true && c.private === false);
  if (incoming.length === 0) {
    return { id: 'description', at: ticket.createdAt };
  }
  incoming.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return { id: String(incoming[0].id), at: incoming[0].createdAt };
}

export const getFreshdeskTicket = createTool({
  id: 'get-freshdesk-ticket',
  description:
    'Fetches a Freshdesk ticket by ID, including the requester info and the full conversation thread. Use this to read a ticket before classifying or replying.',
  inputSchema: z.object({
    ticketId: z.number().describe('Freshdesk ticket ID'),
  }),
  execute: async ({ ticketId }) => fetchFreshdeskTicket(ticketId),
});

/**
 * Fetch the same requester's recent tickets (excluding the current one) so the
 * triage workflow can tell whether this is a repeat issue, an active customer
 * with many open tickets, a returning customer asking again, etc.
 *
 * Best-effort: returns an empty array if requester_id is unknown or Freshdesk
 * returns an error (the triage workflow degrades gracefully without history).
 */
export async function fetchRequesterRecentTickets(
  requesterId: number | null | undefined,
  opts: { excludeTicketId?: number; limit?: number } = {},
): Promise<
  Array<{
    id: number;
    subject: string;
    status: number;
    priority: number;
    groupId: number | null;
    tags: string[];
    createdAt: string;
    updatedAt: string;
  }>
> {
  if (!requesterId) return [];
  const limit = opts.limit ?? 10;
  try {
    const url = new URL(`${freshdeskBase()}/tickets`);
    url.searchParams.set('requester_id', String(requesterId));
    url.searchParams.set('per_page', String(Math.min(limit + 1, 100)));
    url.searchParams.set('order_by', 'updated_at');
    url.searchParams.set('order_type', 'desc');
    const res = await freshdeskFetch(url.toString(), { headers: jsonHeaders() });
    if (!res.ok) {
      console.warn(`[freshdesk] requester-history fetch returned ${res.status} for requester ${requesterId}`);
      return [];
    }
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    return rows
      .filter(t => (t.id as number) !== opts.excludeTicketId)
      .slice(0, limit)
      .map(t => ({
        id: t.id as number,
        subject: (t.subject as string) ?? '',
        status: t.status as number,
        priority: t.priority as number,
        groupId: (t.group_id as number | null) ?? null,
        tags: (t.tags as string[]) ?? [],
        createdAt: t.created_at as string,
        updatedAt: t.updated_at as string,
      }));
  } catch (err) {
    console.warn(`[freshdesk] requester-history fetch failed: ${(err as Error).message}`);
    return [];
  }
}

/** Freshdesk status code → human label. */
export const FRESHDESK_STATUS_LABEL: Record<number, string> = {
  2: 'open',
  3: 'pending',
  4: 'resolved',
  5: 'closed',
  6: 'waiting-on-customer',
  7: 'waiting-on-third-party',
};

/** Freshdesk priority code → human label. */
export const FRESHDESK_PRIORITY_LABEL: Record<number, string> = {
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'urgent',
};

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

// ─── Plain helpers — used by deterministic workflow steps ────────────────────
//
// These are the same HTTP calls the tools above perform, but exported as plain
// async functions so workflows can invoke them WITHOUT routing through an LLM.
// Use these when "post a draft" is a deterministic step in a workflow — relying
// on an LLM to emit the right tool_call is unreliable (it will sometimes
// describe the call as text instead of executing it).

/** Post a PRIVATE NOTE on a ticket. Returns the new conversation id. */
export async function postFreshdeskPrivateNote(args: {
  ticketId: number;
  body: string;
}): Promise<{ conversationId: number; ticketId: number }> {
  const htmlBody = args.body.replace(/\n/g, '<br>');
  const res = await freshdeskFetch(`${freshdeskBase()}/tickets/${args.ticketId}/notes`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ body: htmlBody, private: true }),
  });
  if (!res.ok) throw new Error(`Add note failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { id: number };
  console.log(`[freshdesk] (workflow) Private note on ticket ${args.ticketId} → conv ${data.id}`);
  return { conversationId: data.id, ticketId: args.ticketId };
}

/** Post a PUBLIC REPLY on a ticket. Customer receives this email. */
export async function postFreshdeskReply(args: {
  ticketId: number;
  body: string;
  cc?: string[];
}): Promise<{ conversationId: number; ticketId: number }> {
  const htmlBody = args.body.replace(/\n/g, '<br>');
  const payload: Record<string, unknown> = { body: htmlBody };
  if (args.cc?.length) payload.cc_emails = args.cc;
  const res = await freshdeskFetch(`${freshdeskBase()}/tickets/${args.ticketId}/reply`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Reply failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { id: number };
  console.log(`[freshdesk] (workflow) Public reply on ticket ${args.ticketId} → conv ${data.id}`);
  return { conversationId: data.id, ticketId: args.ticketId };
}

/** Merge-add tags on a ticket. Existing tags are preserved. */
export async function addFreshdeskTags(args: { ticketId: number; tags: string[] }): Promise<void> {
  if (!args.tags.length) return;
  const existing = await freshdeskFetch(`${freshdeskBase()}/tickets/${args.ticketId}`, {
    headers: jsonHeaders(),
  });
  let merged = args.tags;
  if (existing.ok) {
    const t = (await existing.json()) as { tags?: string[] };
    merged = Array.from(new Set([...(t.tags ?? []), ...args.tags]));
  }
  const res = await freshdeskFetch(`${freshdeskBase()}/tickets/${args.ticketId}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({ tags: merged }),
  });
  if (!res.ok) throw new Error(`Tag update failed (${res.status}): ${await res.text()}`);
  console.log(`[freshdesk] (workflow) Tagged ticket ${args.ticketId} with [${args.tags.join(', ')}]`);
}

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
