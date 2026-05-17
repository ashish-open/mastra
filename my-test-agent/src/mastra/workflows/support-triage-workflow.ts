/**
 * Support Triage Workflow
 *
 * Triggered by: freshdesk-webhook route when a ticket is created/updated.
 * Manual run: from Mastra Studio with just a ticketId.
 *
 * Flow:
 *   ticketId → fetch ticket + thread → run supportTriageAgent
 *           → agent classifies, searches KB, drafts reply, posts private note
 *           → returns classification + draft for the run output
 *
 * The agent itself handles all Freshdesk side-effects (private note + tags).
 * This workflow's job is to give the agent the right input and capture results.
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const triageStep = createStep({
  id: 'triage-ticket',
  description: 'Reads a Freshdesk ticket, classifies it, drafts an L1 reply, and posts a private note.',
  inputSchema: z.object({
    ticketId: z.number().describe('Freshdesk ticket ID to triage'),
    autoSendReply: z
      .boolean()
      .default(false)
      .describe('If true, the agent is allowed to post a public reply. Default false = private note only.'),
  }),
  outputSchema: z.object({
    ticketId: z.number(),
    classification: z.string().optional(),
    draftPosted: z.boolean(),
    rawAgentOutput: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const { ticketId, autoSendReply } = inputData;

    const agent = mastra?.getAgent('supportTriageAgent');
    if (!agent) throw new Error('supportTriageAgent not found in Mastra config');

    const safetyClause = autoSendReply
      ? 'You ARE authorized to post a public reply with reply-to-freshdesk-ticket on this run.'
      : 'You are NOT authorized to post a public reply. Use add-freshdesk-private-note only.';

    const replyStep = autoSendReply
      ? '5. Post the draft as a PUBLIC reply using reply-to-freshdesk-ticket (this sends to the customer). Do NOT use add-freshdesk-private-note on this run.'
      : '5. Post the draft as a PRIVATE NOTE (add-freshdesk-private-note) — formatted as instructed.';

    const prompt = `
Triage Freshdesk ticket #${ticketId}.

${safetyClause}

Steps:
1. Call get-freshdesk-ticket with ticketId=${ticketId}.
2. Classify it.
3. Call search-knowledge with a focused query from the ticket.
4. Draft an L1 reply.
${replyStep}
6. Tag the ticket with category:{classification} and "ai-triaged" via update-freshdesk-ticket.

After you're done, respond with one short line:
CLASSIFICATION=<category>
`.trim();

    // Resource-scope memory PER TICKET so re-runs on the same ticket build
    // on prior triage context (working memory + history carry over).
    let agentText = '';
    const stream = await agent.stream([{ role: 'user', content: prompt }], {
      memory: {
        resource: `freshdesk-ticket-${ticketId}`,
        thread: `triage-${ticketId}`,
      },
    });
    for await (const chunk of stream.textStream) {
      agentText += chunk;
    }

    // Extract classification from the agent's final line
    const match = agentText.match(/CLASSIFICATION=([\w_]+)/i);
    const classification = match?.[1];

    console.log(`[support-triage] Ticket ${ticketId} → ${classification ?? 'unknown'}`);

    return {
      ticketId,
      classification,
      draftPosted: true,
      rawAgentOutput: agentText,
    };
  },
});

export const supportTriageWorkflow = createWorkflow({
  id: 'support-triage-workflow',
  inputSchema: z.object({
    ticketId: z.number().describe('Freshdesk ticket ID'),
    autoSendReply: z
      .boolean()
      .default(false)
      .describe('Allow public reply when high-confidence. Default false = private note only (recommended).'),
  }),
  outputSchema: z.object({
    ticketId: z.number(),
    classification: z.string().optional(),
    draftPosted: z.boolean(),
    rawAgentOutput: z.string(),
  }),
}).then(triageStep);

supportTriageWorkflow.commit();
