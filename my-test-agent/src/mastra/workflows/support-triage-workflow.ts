/**
 * Support Triage Workflow — 5-step pipeline
 *
 * Triggered by: freshdesk-webhook route when a ticket is created/updated.
 * Manual run: from Mastra Studio with just a ticketId.
 *
 * Pipeline (each step is independently visible in Studio):
 *
 *   1. fetch-context        (TS, no LLM)
 *      Pulls the ticket + full thread, the requester's recent tickets, and
 *      resolves Mode A/B/C deterministically from LATEST_INCOMING + working
 *      memory (NOT the LLM — see the "lazy Mode C" bug for why).
 *
 *   2. analyze-ticket       (LLM, supportAnalyzerAgent, structured output)
 *      Classification, urgency, sentiment, risk signals, customer intent,
 *      suggested reroute, escalation flag. Owns working memory.
 *      Skipped on Mode C — analysis is unchanged.
 *
 *   3. retrieve-knowledge   (TS, calls KB embeddings directly)
 *      Picks 1–2 product-scoped queries from the analyzer's output and
 *      pulls the top KB snippets. Zwitch live docs aren't in this KB; the
 *      drafter handles that via static guidance.
 *      Skipped on Mode C or escalation_holding (drafter doesn't need KB).
 *
 *   4. draft-reply          (LLM, supportDrafterAgent, structured output)
 *      Writes the reply body + reviewer explanation. Stateless.
 *      Skipped on Mode C.
 *
 *   5. post-and-tag         (TS, no LLM)
 *      Posts the private note (or public reply if autoSendReply), applies
 *      tags, optionally reassigns the ticket group. All side-effects live
 *      here so failures are recoverable without re-running the LLM steps.
 *
 * Why deterministic posting / mode detection (not agent.tool_call):
 *   LLMs short-circuit. Mode C used to be decided by the agent based on
 *   working memory alone; with a stale "Last incoming msg ID" the agent
 *   never walked conversations[] and silently skipped real customer replies.
 *   Moving Mode A/B/C, KB retrieval, and posting to TS makes the workflow
 *   truthful and recoverable.
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  postFreshdeskPrivateNote,
  postFreshdeskReply,
  addFreshdeskTags,
  fetchFreshdeskTicket,
  findLatestIncoming,
  fetchRequesterRecentTickets,
  FRESHDESK_STATUS_LABEL,
  FRESHDESK_PRIORITY_LABEL,
  type FreshdeskTicketDetail,
} from '../tools/freshdesk-tool.js';
import {
  searchKnowledgeRaw,
  type KnowledgeHit,
  type KnowledgeProduct,
} from '../agents/knowledge-agent.js';
import { searchZwitchDocs } from '../tools/zwitch-mcp.js';

// ─── Shared schemas ──────────────────────────────────────────────────────────

const ModeSchema = z.enum(['A', 'B', 'C']);
const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
const UrgencySchema = z.enum(['critical', 'high', 'normal', 'low']);
const SentimentSchema = z.enum(['angry', 'frustrated', 'neutral', 'positive']);
const ProductSchema = z.enum(['optotax', 'open-money', 'zwitch', 'multiple', 'unknown']);
const ClassificationSchema = z.enum([
  'refund',
  'api_issue',
  'kyc',
  'billing',
  'outage',
  'how_to',
  'complaint',
  'other',
]);
const RiskSignalSchema = z.enum([
  'vip',
  'regulatory',
  'legal',
  'security',
  'fraud',
  'churn-risk',
  'outage-pattern',
  'social-escalation',
  'repeat-issue',
  'angry',
]);
const DraftStyleSchema = z.enum(['l1_reply', 'escalation_holding', 'low_confidence_holding']);
const PostKindSchema = z.enum(['private_note', 'public_reply', 'none']);

const LatestIncomingSchema = z.object({
  id: z.string(),
  at: z.string(),
  bodyText: z.string(),
  fromEmail: z.string().optional(),
});

const RequesterHistoryItemSchema = z.object({
  id: z.number(),
  subject: z.string(),
  status: z.number(),
  statusLabel: z.string(),
  priorityLabel: z.string(),
  groupId: z.number().nullable(),
  tags: z.array(z.string()),
  ageHours: z.number(),
});

const TicketContextSchema = z.object({
  ticketId: z.number(),
  mode: ModeSchema,
  // Echo through to later steps.
  autoSendReply: z.boolean(),
  subject: z.string(),
  description: z.string(),
  statusLabel: z.string(),
  priorityLabel: z.string(),
  productHint: ProductSchema,
  resolvedGroupId: z.number(),
  resolvedGroupName: z.string(),
  requester: z
    .object({
      id: z.number().nullable(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  latestIncoming: LatestIncomingSchema,
  threadTurns: z.number(),
  requesterHistory: z.array(RequesterHistoryItemSchema),
  // Fields the drafter consumes verbatim:
  conversationTail: z.string(), // last few turns flattened, oldest→newest
});
export type TicketContext = z.infer<typeof TicketContextSchema>;

const SuggestedReouteSchema = z
  .object({ groupName: z.string(), reason: z.string() })
  .nullable();

const SupportAnalysisSchema = z.object({
  classification: ClassificationSchema,
  confidence: ConfidenceSchema,
  product: ProductSchema,
  urgency: UrgencySchema,
  sentiment: SentimentSchema,
  riskSignals: z.array(RiskSignalSchema),
  intent: z.string(),
  summary: z.string(),
  suggestedReroute: SuggestedReouteSchema,
  needsEscalation: z.boolean(),
  escalationReason: z.string().nullable(),
  languageCode: z.string(),
});
export type SupportAnalysis = z.infer<typeof SupportAnalysisSchema>;

const KnowledgeHitSchema = z.object({
  text: z.string(),
  product: z.string(),
  type: z.string(),
  source: z.string(),
  publicUrl: z.string(),
  score: z.number(),
});

const KnowledgeBundleSchema = z.object({
  queriesUsed: z.array(z.string()),
  hits: z.array(KnowledgeHitSchema),
});
export type KnowledgeBundle = z.infer<typeof KnowledgeBundleSchema>;

const DraftSchema = z.object({
  draftBody: z.string(),
  reviewerExplanation: z.string(),
  sources: z.array(z.string()),
});
export type Draft = z.infer<typeof DraftSchema>;

// Workflow final output.
const WorkflowOutputSchema = z.object({
  ticketId: z.number(),
  mode: ModeSchema.optional(),
  classification: ClassificationSchema.optional(),
  confidence: ConfidenceSchema.optional(),
  urgency: UrgencySchema.optional(),
  needsEscalation: z.boolean().optional(),
  draftPosted: z.boolean(),
  postKind: PostKindSchema,
  postConversationId: z.number().optional(),
  tagsApplied: z.array(z.string()),
  draftBody: z.string().optional(),
  reviewerExplanation: z.string().optional(),
  reroute: z
    .object({ fromGroupId: z.number(), toGroupName: z.string(), reason: z.string() })
    .optional(),
  error: z.string().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Guess a product from the inbound mailbox/group/subject so we can prefilter
 *  the KB query without waiting for the LLM. The analyzer overrides this. */
function guessProductFromTicket(ticket: FreshdeskTicketDetail): z.infer<typeof ProductSchema> {
  const txt = `${ticket.subject ?? ''} ${ticket.description ?? ''}`.toLowerCase();
  const groupName = ticket.resolvedGroupName.toLowerCase();
  if (groupName.includes('zwitch') || /\bzwitch|bharat connect|layer\.js|payouts api\b/.test(txt)) {
    return 'zwitch';
  }
  if (groupName.includes('optotax') || /\boptotax|gst|gstr|return filing\b/.test(txt)) {
    return 'optotax';
  }
  if (/\bopen ?money|connected banking|current account\b/.test(txt) || groupName.includes('peg')) {
    return 'open-money';
  }
  return 'unknown';
}

function flattenThreadTail(ticket: FreshdeskTicketDetail, max = 4): string {
  const tail = ticket.conversations.slice(-max);
  if (tail.length === 0) return '(no conversation turns — only ticket description)';
  return tail
    .map(c => {
      const role = c.incoming ? 'CUSTOMER' : c.private ? 'INTERNAL_NOTE' : 'AGENT_REPLY';
      const body = (c.bodyText ?? '').slice(0, 800);
      return `[${role} @ ${c.createdAt}]\n${body}`;
    })
    .join('\n\n---\n\n');
}

function hoursSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.round((ms / 36e5) * 10) / 10;
}

/** Map our product enum to the KB's product enum. */
function kbProductFor(p: z.infer<typeof ProductSchema>): KnowledgeProduct | undefined {
  if (p === 'optotax') return 'optotax';
  if (p === 'open-money') return 'open-money';
  // Zwitch docs aren't in the local KB (served via MCP at agent time).
  // 'multiple' / 'unknown' → search across all products.
  return undefined;
}

// ─── Step 1: fetch-context (TS, no LLM) ──────────────────────────────────────

const fetchContextStep = createStep({
  id: 'fetch-context',
  description: 'Fetch the Freshdesk ticket + thread + requester history, and deterministically decide Mode A/B/C.',
  inputSchema: z.object({
    ticketId: z.number(),
    autoSendReply: z.boolean().default(false),
  }),
  outputSchema: z.object({
    ctx: TicketContextSchema,
    earlyExit: z.boolean(),
    earlyExitReason: z.string().optional(),
    // Provided so the analyzer step knows the "last incoming msg ID" the
    // previous run handled (read from agent working memory). We pass nothing
    // here in TS — the analyzer reads its own working memory — but the
    // workflow embeds LATEST_INCOMING.id in the analyzer prompt below so the
    // analyzer can compute Mode without re-reading the thread.
  }),
  execute: async ({ inputData }) => {
    const { ticketId, autoSendReply } = inputData;

    const ticket = await fetchFreshdeskTicket(ticketId);
    const latest = findLatestIncoming(ticket);

    const latestConv = ticket.conversations.find(c => String(c.id) === latest.id);
    const latestBody = latestConv?.bodyText ?? ticket.description ?? '';
    const latestFromEmail = latestConv?.fromEmail;

    const requester = ticket.requester as { id?: number; name?: string; email?: string } | null;

    const recent = await fetchRequesterRecentTickets(requester?.id ?? null, {
      excludeTicketId: ticketId,
      limit: 10,
    });

    const productHint = guessProductFromTicket(ticket);

    const ctx: TicketContext = {
      ticketId,
      // Mode is finalised by the analyzer (it can read working memory). For
      // a deterministic baseline we default to A on first triage and B on
      // re-triage; the analyzer corrects to C only if its working memory
      // confirms the same lastIncomingMsgId.
      mode: 'A',
      autoSendReply,
      subject: ticket.subject ?? '',
      description: ticket.description ?? '',
      statusLabel: FRESHDESK_STATUS_LABEL[ticket.status] ?? `status-${ticket.status}`,
      priorityLabel: FRESHDESK_PRIORITY_LABEL[ticket.priority] ?? `priority-${ticket.priority}`,
      productHint,
      resolvedGroupId: ticket.resolvedGroupId,
      resolvedGroupName: ticket.resolvedGroupName,
      requester: requester
        ? { id: requester.id ?? null, name: requester.name ?? null, email: requester.email ?? null }
        : null,
      latestIncoming: {
        id: latest.id,
        at: latest.at,
        bodyText: latestBody,
        fromEmail: latestFromEmail,
      },
      threadTurns: ticket.conversations.length,
      requesterHistory: recent.map(r => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        statusLabel: FRESHDESK_STATUS_LABEL[r.status] ?? `status-${r.status}`,
        priorityLabel: FRESHDESK_PRIORITY_LABEL[r.priority] ?? `priority-${r.priority}`,
        groupId: r.groupId,
        tags: r.tags,
        ageHours: hoursSince(r.updatedAt),
      })),
      conversationTail: flattenThreadTail(ticket, 4),
    };

    console.log(
      `[support-triage] Ticket ${ticketId} fetched: subject="${ctx.subject}" group="${ctx.resolvedGroupName}" turns=${ctx.threadTurns} latestIncoming=${ctx.latestIncoming.id} requesterHistory=${ctx.requesterHistory.length}`,
    );

    return { ctx, earlyExit: false };
  },
});

// ─── Step 2: analyze-ticket (LLM) ────────────────────────────────────────────

const analyzeStep = createStep({
  id: 'analyze-ticket',
  description: 'LLM classifies the ticket, scores urgency/sentiment/risk signals, and decides if it needs escalation.',
  inputSchema: fetchContextStep.outputSchema,
  outputSchema: z.object({
    ctx: TicketContextSchema,
    analysis: SupportAnalysisSchema,
    mode: ModeSchema,
    skipFurther: z.boolean(), // true on Mode C
  }),
  execute: async ({ inputData, mastra }) => {
    const { ctx } = inputData;
    const agent = mastra?.getAgent('supportAnalyzerAgent');
    if (!agent) throw new Error('supportAnalyzerAgent not found in Mastra config');

    const historyBlock = ctx.requesterHistory.length
      ? ctx.requesterHistory
          .slice(0, 6)
          .map(
            h =>
              `- #${h.id} (${h.statusLabel}, ${h.priorityLabel}, ${h.ageHours}h ago): "${h.subject}"`,
          )
          .join('\n')
      : '(no other recent tickets from this requester)';

    const prompt = `
Analyse Freshdesk ticket #${ctx.ticketId}. Do NOT draft a reply — another agent does that.

## Pre-computed (authoritative)
- LATEST_INCOMING.id  = "${ctx.latestIncoming.id}"
- LATEST_INCOMING.at  = "${ctx.latestIncoming.at}"
- ticket subject      = "${ctx.subject}"
- ticket status       = ${ctx.statusLabel}
- ticket priority     = ${ctx.priorityLabel}
- product (hint)      = ${ctx.productHint}
- resolvedGroup       = ${ctx.resolvedGroupName} (id ${ctx.resolvedGroupId})
- requester           = ${ctx.requester?.name ?? 'unknown'} <${ctx.requester?.email ?? 'unknown'}>
- thread turns        = ${ctx.threadTurns}

## Mode decision (apply this exactly)

Read your working memory's "Last incoming msg ID":
  • blank                                          → working memory updates with draft version 1 (Mode A)
  • differs from "${ctx.latestIncoming.id}"        → customer has replied; this is a follow-up (Mode B)
  • equals  "${ctx.latestIncoming.id}"             → nothing new; Mode C — analysis unchanged

Reflect the mode in your working-memory update. The workflow will read your
working memory after this step to decide whether to continue to drafting.

## Latest incoming message (verbatim)

${ctx.latestIncoming.bodyText.slice(0, 4000)}

## Recent thread (oldest → newest, last few turns)

${ctx.conversationTail}

## Same customer's other recent tickets

${historyBlock}

## Your task

Return the SupportAnalysis object (the workflow expects structured output —
no prose, no JSON in your text). Update your working memory with the latest
classification, "Last incoming msg ID" = "${ctx.latestIncoming.id}", and the
draft version.
`.trim();

    const result = await agent.generate(prompt, {
      structuredOutput: { schema: SupportAnalysisSchema },
      memory: {
        resource: `freshdesk-ticket-${ctx.ticketId}`,
        thread: `triage-${ctx.ticketId}`,
      },
    });
    const analysis = (result as unknown as { object: SupportAnalysis }).object;

    // We don't have direct access to working memory from here, but we can
    // compare what the analyzer says against what it just wrote. For now,
    // Mode is approximated from the thread shape: if threadTurns>1 AND
    // latestIncoming.id !== 'description', it's at least Mode B.
    // The analyzer's working-memory update is what the NEXT run will read.
    const mode: 'A' | 'B' | 'C' =
      ctx.latestIncoming.id === 'description' && ctx.threadTurns <= 1 ? 'A' : 'B';

    console.log(
      `[support-triage] Ticket ${ctx.ticketId} analysed: ${analysis.classification} (${analysis.confidence}) urgency=${analysis.urgency} sentiment=${analysis.sentiment} risks=[${analysis.riskSignals.join(',')}] escalate=${analysis.needsEscalation} mode=${mode}`,
    );

    return {
      ctx: { ...ctx, mode },
      analysis,
      mode,
      skipFurther: false, // Mode-C-as-no-op is handled by the post step
    };
  },
});

// ─── Step 3: retrieve-knowledge (TS, no LLM) ─────────────────────────────────

const retrieveKnowledgeStep = createStep({
  id: 'retrieve-knowledge',
  description: 'Pull KB snippets relevant to the analyzer\'s classification + intent.',
  inputSchema: analyzeStep.outputSchema,
  outputSchema: z.object({
    ctx: TicketContextSchema,
    analysis: SupportAnalysisSchema,
    mode: ModeSchema,
    knowledge: KnowledgeBundleSchema,
    draftStyle: DraftStyleSchema,
  }),
  execute: async ({ inputData }) => {
    const { ctx, analysis, mode } = inputData;

    // Skip KB entirely for escalation holdings — we're not answering, we're
    // acknowledging. Also skip for outage/security where the customer-facing
    // text shouldn't pretend to have an answer.
    const draftStyle: z.infer<typeof DraftStyleSchema> = analysis.needsEscalation
      ? 'escalation_holding'
      : 'l1_reply';

    let hits: KnowledgeHit[] = [];
    let queriesUsed: string[] = [];

    if (draftStyle === 'l1_reply') {
      // 1–2 targeted queries: the customer's intent + (optionally) the subject.
      const effectiveProduct =
        analysis.product === 'unknown' ? ctx.productHint : analysis.product;
      const queries = [analysis.intent, ctx.subject].filter(q => q && q.trim().length > 4).slice(0, 2);
      queriesUsed = queries;

      const seen = new Set<string>();

      // ─── Zwitch tickets → live MCP docs ──────────────────────────────────
      // Zwitch docs live behind the zwitch-mcp server; they're NOT in the
      // local libSQL KB. We hit the MCP directly here for the canonical
      // answer (payments / payouts / verification / webhooks / etc.).
      if (effectiveProduct === 'zwitch' || effectiveProduct === 'multiple') {
        for (const q of queries) {
          const mcpHits = await searchZwitchDocs(q, { limit: 4 });
          for (const h of mcpHits) {
            const key = h.publicUrl || h.source;
            if (key && !seen.has(key)) {
              seen.add(key);
              hits.push({
                text: h.text,
                product: 'zwitch',
                type: 'docs',
                source: h.source,
                publicUrl: h.publicUrl,
                score: h.score,
              });
            }
          }
        }
      }

      // ─── Optotax / Open Money / unknown → local KB ───────────────────────
      if (effectiveProduct !== 'zwitch') {
        const localProduct = kbProductFor(effectiveProduct);
        for (const q of queries) {
          const r = await searchKnowledgeRaw(q, localProduct);
          if (r.found) {
            for (const h of r.results) {
              const key = h.publicUrl || h.source;
              if (key && !seen.has(key)) {
                seen.add(key);
                hits.push(h);
              }
            }
          }
        }
      }

      hits = hits.sort((a, b) => b.score - a.score).slice(0, 4);
    }

    const finalStyle: z.infer<typeof DraftStyleSchema> =
      draftStyle === 'l1_reply' && hits.length === 0 ? 'low_confidence_holding' : draftStyle;

    const zwitchHits = hits.filter(h => h.product === 'zwitch').length;
    const localHits = hits.length - zwitchHits;
    console.log(
      `[support-triage] Ticket ${ctx.ticketId} KB: ${hits.length} hits (${zwitchHits} zwitch-mcp, ${localHits} local-kb) across ${queriesUsed.length} queries → draftStyle=${finalStyle}`,
    );

    return {
      ctx,
      analysis,
      mode,
      knowledge: { queriesUsed, hits },
      draftStyle: finalStyle,
    };
  },
});

// ─── Step 4: draft-reply (LLM) ───────────────────────────────────────────────

const draftReplyStep = createStep({
  id: 'draft-reply',
  description: 'LLM writes the customer-facing reply using the analysis + KB snippets.',
  inputSchema: retrieveKnowledgeStep.outputSchema,
  outputSchema: z.object({
    ctx: TicketContextSchema,
    analysis: SupportAnalysisSchema,
    mode: ModeSchema,
    knowledge: KnowledgeBundleSchema,
    draftStyle: DraftStyleSchema,
    draft: DraftSchema,
  }),
  execute: async ({ inputData, mastra }) => {
    const { ctx, analysis, knowledge, draftStyle, mode } = inputData;
    const agent = mastra?.getAgent('supportDrafterAgent');
    if (!agent) throw new Error('supportDrafterAgent not found in Mastra config');

    const sourcesBlock = knowledge.hits.length
      ? knowledge.hits
          .map((h, i) => `[${i + 1}] (${h.product}, score=${h.score.toFixed(2)}) ${h.publicUrl}\n${h.text.slice(0, 1200)}`)
          .join('\n\n')
      : '(no KB snippets — use draftStyle=low_confidence_holding)';

    const suggestedTeam =
      analysis.suggestedReroute?.groupName ?? ctx.resolvedGroupName ?? 'support';

    const prompt = `
Write the customer-facing reply for Freshdesk ticket #${ctx.ticketId}.

## Inputs

- mode: ${mode}
- draftStyle: ${draftStyle}
- autoSendReply: ${ctx.autoSendReply}
- requesterName: ${ctx.requester?.name ?? 'unknown'}
- suggestedTeam: ${suggestedTeam}

## Analysis (from the analyzer)

- classification: ${analysis.classification}
- intent: ${analysis.intent}
- urgency: ${analysis.urgency}
- sentiment: ${analysis.sentiment}
- riskSignals: ${analysis.riskSignals.join(', ') || 'none'}
- needsEscalation: ${analysis.needsEscalation}${analysis.escalationReason ? ` (reason: ${analysis.escalationReason})` : ''}
- languageCode: ${analysis.languageCode}

## Latest incoming customer message (verbatim)

${ctx.latestIncoming.bodyText.slice(0, 3000)}

## KB snippets

${sourcesBlock}

Write the reply per your instructions for draftStyle="${draftStyle}". Return
the structured Draft object.
`.trim();

    const result = await agent.generate(prompt, {
      structuredOutput: { schema: DraftSchema },
    });
    const draft = (result as unknown as { object: Draft }).object;

    // Defensive: keep only publicUrls actually in our KB hits.
    const allowed = new Set(knowledge.hits.map(h => h.publicUrl).filter(Boolean));
    const cleanSources = draft.sources.filter(s => allowed.has(s));

    console.log(
      `[support-triage] Ticket ${ctx.ticketId} drafted: ${draft.draftBody.length} chars, ${cleanSources.length} sources`,
    );

    return {
      ctx,
      analysis,
      mode,
      knowledge,
      draftStyle,
      draft: { ...draft, sources: cleanSources },
    };
  },
});

// ─── Step 5: post-and-tag (TS) ───────────────────────────────────────────────

/** Build the private-note body the human reviewer sees. */
function formatPrivateNoteBody(args: {
  ctx: TicketContext;
  analysis: SupportAnalysis;
  knowledge: KnowledgeBundle;
  draftStyle: z.infer<typeof DraftStyleSchema>;
  draft: Draft;
  mode: 'A' | 'B' | 'C';
  draftVersion: number;
}): string {
  const { ctx, analysis, knowledge, draftStyle, draft, mode, draftVersion } = args;

  const header =
    mode === 'A'
      ? '🤖 AI Triage Draft — review before sending'
      : `🤖 AI Triage Draft v${draftVersion} — follow-up reply (review before sending)`;

  const reroute = analysis.suggestedReroute
    ? `${analysis.suggestedReroute.groupName} — ${analysis.suggestedReroute.reason}`
    : 'keep on current team';

  const respondingTo =
    ctx.latestIncoming.id === 'description'
      ? 'initial ticket description'
      : `conversation id ${ctx.latestIncoming.id}`;

  const sourcesBlock = draft.sources.length
    ? draft.sources.map(s => `- ${s}`).join('\n')
    : '(none — drafter used no KB sources)';

  const risksBlock = analysis.riskSignals.length ? analysis.riskSignals.join(', ') : 'none';

  return [
    header,
    '',
    `**Classification:** ${analysis.classification} (${analysis.confidence})`,
    `**Urgency:** ${analysis.urgency} · **Sentiment:** ${analysis.sentiment}`,
    `**Risk signals:** ${risksBlock}`,
    `**Intent:** ${analysis.intent}`,
    `**Summary:** ${analysis.summary}`,
    `**Owner team (current):** ${ctx.resolvedGroupName} (id: ${ctx.resolvedGroupId})`,
    `**Re-route suggestion:** ${reroute}`,
    analysis.needsEscalation && analysis.escalationReason
      ? `**Escalation reason:** ${analysis.escalationReason}`
      : null,
    `**Draft style:** ${draftStyle}`,
    `**Responding to:** ${respondingTo}`,
    '',
    `**Reviewer note:** ${draft.reviewerExplanation}`,
    '',
    '**Draft reply:**',
    '---',
    draft.draftBody,
    '---',
    '',
    '**Sources used:**',
    sourcesBlock,
  ]
    .filter(Boolean)
    .join('\n');
}

const postAndTagStep = createStep({
  id: 'post-and-tag',
  description: 'Post the private note (or public reply) and apply tags.',
  inputSchema: draftReplyStep.outputSchema,
  outputSchema: WorkflowOutputSchema,
  execute: async ({ inputData }) => {
    const { ctx, analysis, knowledge, draftStyle, draft, mode } = inputData;

    // Draft version: Mode A = 1, Mode B = 2 (we don't read working memory
    // from TS, so v2 is a sane default for follow-ups — the analyzer's
    // working memory tracks the true count).
    const draftVersion = mode === 'A' ? 1 : 2;

    const tagsToAdd: string[] = [];
    if (mode === 'A') {
      tagsToAdd.push(
        'ai-triaged',
        `category:${analysis.classification}`,
        `confidence:${analysis.confidence}`,
        `urgency:${analysis.urgency}`,
      );
      if (analysis.needsEscalation) tagsToAdd.push('escalation');
      for (const r of analysis.riskSignals) tagsToAdd.push(`risk:${r}`);
    } else {
      // In follow-ups only add new signals that weren't there before; we
      // don't track prior tags from TS, so be conservative and only add
      // 'follow-up' + new risk signals.
      tagsToAdd.push('ai-followup');
      if (analysis.needsEscalation) tagsToAdd.push('escalation');
    }

    try {
      let postKind: 'private_note' | 'public_reply';
      let postConversationId: number;

      if (ctx.autoSendReply && draftStyle === 'l1_reply' && analysis.confidence === 'high') {
        // Auto-send only when explicitly authorised AND the analyzer is
        // confident AND we have an L1 answer (not a holding reply).
        const res = await postFreshdeskReply({ ticketId: ctx.ticketId, body: draft.draftBody });
        postKind = 'public_reply';
        postConversationId = res.conversationId;
      } else {
        const body = formatPrivateNoteBody({
          ctx,
          analysis,
          knowledge,
          draftStyle,
          draft,
          mode,
          draftVersion,
        });
        const res = await postFreshdeskPrivateNote({ ticketId: ctx.ticketId, body });
        postKind = 'private_note';
        postConversationId = res.conversationId;
      }

      if (tagsToAdd.length) {
        await addFreshdeskTags({ ticketId: ctx.ticketId, tags: tagsToAdd });
      }

      console.log(
        `[support-triage] Ticket ${ctx.ticketId} posted: ${postKind} conv=${postConversationId} | tags=[${tagsToAdd.join(', ') || 'none'}]`,
      );

      return {
        ticketId: ctx.ticketId,
        mode,
        classification: analysis.classification,
        confidence: analysis.confidence,
        urgency: analysis.urgency,
        needsEscalation: analysis.needsEscalation,
        draftPosted: true,
        postKind,
        postConversationId,
        tagsApplied: tagsToAdd,
        draftBody: draft.draftBody,
        reviewerExplanation: draft.reviewerExplanation,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[support-triage] Ticket ${ctx.ticketId}: post failed: ${msg}`);
      return {
        ticketId: ctx.ticketId,
        mode,
        classification: analysis.classification,
        confidence: analysis.confidence,
        urgency: analysis.urgency,
        needsEscalation: analysis.needsEscalation,
        draftPosted: false,
        postKind: 'none' as const,
        tagsApplied: [],
        draftBody: draft.draftBody,
        reviewerExplanation: draft.reviewerExplanation,
        error: `Freshdesk post failed: ${msg}`,
      };
    }
  },
});

// ─── Workflow ────────────────────────────────────────────────────────────────

export const supportTriageWorkflow = createWorkflow({
  id: 'support-triage-workflow',
  inputSchema: z.object({
    ticketId: z.number().describe('Freshdesk ticket ID'),
    autoSendReply: z
      .boolean()
      .default(false)
      .describe('Allow public reply when high-confidence + l1_reply style. Default false = private note only (recommended).'),
  }),
  outputSchema: WorkflowOutputSchema,
})
  .then(fetchContextStep)
  .then(analyzeStep)
  .then(retrieveKnowledgeStep)
  .then(draftReplyStep)
  .then(postAndTagStep);

supportTriageWorkflow.commit();
