/**
 * Memory profiles per agent.
 *
 * Each agent gets a Memory instance configured with:
 *   - lastMessages: how much chat history to include in every turn
 *   - workingMemory: a structured Markdown template the agent maintains across
 *     turns (notes, preferences, ongoing state)
 *   - scope: 'thread' = isolated per chat session, 'resource' = shared across
 *     all sessions with the same resourceId (e.g. one ticket, one meeting,
 *     one merchant)
 *
 * Workflow callers pass `{ memory: { resource: '...', thread: '...' } }` to
 * agent.stream() / agent.generate() so working memory persists across
 * re-runs of the same workflow on the same entity.
 *
 * NOTE: semantic recall (vector search over old messages) is intentionally
 * NOT enabled here. It requires an embedder + vector index and adds latency
 * to every turn. We'll opt in per-agent later if the use-case warrants it.
 */

import { Memory } from '@mastra/memory';

// ─── Working-memory templates ─────────────────────────────────────────────────

/** Knowledge Bot — direct user chat. Track who's asking and what they care about. */
const KNOWLEDGE_TEMPLATE = `# User Profile

- **Role**: <CA / Tax practitioner / Developer / Internal team / Unknown>
- **Primary product**: <Optotax / Open Money / Zwitch / Multiple>
- **Open questions**:
  - (track unanswered or partially-answered questions across the session)

# Conversation Notes

- **Last topic**:
- **Cited sources** (avoid re-citing same URL repeatedly):
`;

/** Zeus — agentic-payments agent. Track mandate state and daily spending. */
const ZEUS_TEMPLATE = `# Mandate State

- **Per-transaction limit**: ₹2,000
- **Daily limit**: ₹5,000
- **Allowed categories**: SaaS, cloud_infra, developer_tools

# Today's Activity (UTC date: <YYYY-MM-DD>)

- **Spent today**: ₹<running total>
- **Remaining today**: ₹<5000 - spent>
- **Recent payments** (last 5):
  - <amount> to <merchant> [<category>] — <payment_id>

# Blocked / Failed

- **Recent blocks**:
  - <merchant> — reason: <out-of-mandate / failed-cryptogram / failed-payment>
`;

/** Support Triage — runs once per ticket, then again for each new incoming
 *  reply on that ticket. Resource-scoped per Freshdesk ticket so the agent
 *  can detect "customer replied again since my last draft" via the
 *  Last-incoming-msg fields. */
const SUPPORT_TRIAGE_TEMPLATE = `# Ticket Context

- **Ticket ID**:
- **Subject**:
- **Customer**: <name> <email>
- **Inbound mailbox**: (e.g. letstalk@open.money)
- **Owner team**: <group_name> (id: <group_id>)

# Triage History

- **Latest classification**: <category>
- **Confidence**: <high/medium/low>
- **Tags applied**: <ai-triaged, category:X, ...>
- **Last incoming msg ID**: <conversation.id of the most recent INCOMING msg you've responded to — leave blank on first triage>
- **Last incoming msg at**: <ISO timestamp of that incoming msg, e.g. 2026-05-21T03:14:15Z>
- **Draft version**: <integer; 1 on first triage, +1 per follow-up reply>

# Notes for Human Reviewer

- **Sources cited in draft** (publicUrls only):
- **Things I was unsure about**:
- **Suggested follow-up if customer replies**:
`;

/** Meeting Summarizer — runs once per meeting. Resource-scoped per Recall.ai bot. */
const MEETING_TEMPLATE = `# Meeting Context

- **Bot ID**:
- **Title**:
- **Type**: <sales / onboarding / support / ops / general>
- **Duration**: <minutes>
- **Speakers**: <count>

# Outcomes

- **Key decisions**:
- **Action items** (who / what / when):
- **Open questions raised**:
- **Follow-up meeting**: <yes/no, when>

# KB Cross-References

- **Product topics looked up**: <Zwitch payouts, GSTR-3B, etc.>
- **Public URLs cited**:
`;

// ─── Factory ──────────────────────────────────────────────────────────────────

interface ProfileOpts {
  /** How many recent messages to include in every turn (default 20) */
  lastMessages?: number;
  /** Working-memory scope. 'resource' persists across all sessions for the
   *  same resourceId; 'thread' isolates to one session. (default 'thread') */
  scope?: 'thread' | 'resource';
  /** The Markdown template the agent maintains as long-term notes */
  template: string;
  /** Read-only: agent can read working memory but won't update it (rarely used) */
  readOnly?: boolean;
}

function makeMemory(opts: ProfileOpts): Memory {
  return new Memory({
    options: {
      lastMessages: opts.lastMessages ?? 20,
      workingMemory: {
        enabled: true,
        scope: opts.scope ?? 'thread',
        template: opts.template,
      },
      ...(opts.readOnly ? { readOnly: true } : {}),
    },
  });
}

// ─── Per-agent profiles ───────────────────────────────────────────────────────

/** Knowledge Bot — direct chat. Thread-scoped (each conversation independent). */
export const knowledgeMemory = makeMemory({
  scope: 'thread',
  lastMessages: 30,
  template: KNOWLEDGE_TEMPLATE,
});

/**
 * Zeus — agentic payments. Resource-scoped by user so daily spending tracking
 * persists across sessions for the same actor. Workflow caller passes
 * `resource: <userId-or-'default'>`.
 */
export const zeusMemory = makeMemory({
  scope: 'resource',
  lastMessages: 20,
  template: ZEUS_TEMPLATE,
});

/**
 * Support Triage — resource-scoped per Freshdesk ticket so re-runs on the
 * same ticket build on prior context. Caller passes
 * `resource: 'freshdesk-ticket-<ticketId>'`.
 */
export const supportTriageMemory = makeMemory({
  scope: 'resource',
  lastMessages: 15,
  template: SUPPORT_TRIAGE_TEMPLATE,
});

/**
 * Meeting Summarizer — resource-scoped per Recall.ai bot so re-runs on the
 * same meeting accumulate context. Caller passes `resource: 'meeting-<botId>'`.
 */
export const meetingMemory = makeMemory({
  scope: 'resource',
  lastMessages: 10,
  template: MEETING_TEMPLATE,
});
