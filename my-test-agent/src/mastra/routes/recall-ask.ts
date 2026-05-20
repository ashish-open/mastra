/**
 * Meeting Q&A Route — POST /recall/ask/:botId
 *
 * Allows anyone (teams, OpenArc UI, Slack bots) to ask a question about a
 * completed meeting. The meeting agent answers from the transcript it stored
 * in memory during processMeetingWorkflow.
 *
 * Request:
 *   POST /recall/ask/:botId
 *   Body: { "question": "What was decided about the refund dashboard?" }
 *
 * Response:
 *   { "botId": "...", "question": "...", "answer": "..." }
 *
 * Auth: Bearer token via RECALL_RECOVER_SECRET (same as recovery routes).
 *
 * Memory scope: resource = meeting-{botId} — the same scope used by
 * processMeetingWorkflow, so the agent has the full transcript + summary
 * context without re-downloading anything.
 *
 * Each Q&A exchange is stored in its own thread (qa-session-{botId}) so
 * follow-up questions in the same session stay coherent.
 */

import type { ApiRoute } from '@mastra/core/server';

function authorizeRequest(authHeader: string | undefined): boolean {
  const secret = process.env.RECALL_RECOVER_SECRET;
  if (!secret) {
    console.error('[recall-ask] RECALL_RECOVER_SECRET not set — rejecting request');
    return false;
  }
  return authHeader === `Bearer ${secret}`;
}

export const recallAskRoute: ApiRoute = {
  path: '/recall/ask/:botId',
  method: 'POST',
  requiresAuth: false, // guarded by RECALL_RECOVER_SECRET
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: ({ mastra }): any => Promise.resolve(async (c: any) => {
    if (!authorizeRequest(c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const botId = c.req.param('botId') as string;

    let body: { question?: string; sessionId?: string };
    try {
      body = await c.req.json() as { question?: string; sessionId?: string };
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const question = body.question?.trim();
    if (!question) {
      return c.json({ error: 'Body must include a non-empty "question" field' }, 400);
    }

    // sessionId lets callers maintain a multi-turn conversation about the same meeting.
    // Defaults to a single shared QA thread per bot.
    const sessionId = body.sessionId ?? 'default';

    const agent = (mastra as unknown as {
      getAgent: (id: string) => {
        stream: (
          messages: { role: string; content: string }[],
          opts: { memory: { resource: string; thread: string } }
        ) => Promise<{ textStream: AsyncIterable<string> }>;
      } | undefined;
    }).getAgent('meetingAgent');

    if (!agent) {
      return c.json({ error: 'meeting-agent not found' }, 500);
    }

    console.log(`[recall-ask] Q&A — bot: ${botId}, session: ${sessionId}, q: "${question.slice(0, 80)}"`);

    let answer = '';
    try {
      const response = await agent.stream(
        [{ role: 'user', content: question }],
        {
          memory: {
            // Same resource as processMeetingWorkflow — agent has full transcript context
            resource: `meeting-${botId}`,
            // Thread per session so multi-turn works; different sessionIds = fresh conversation
            thread: `qa-${sessionId}-${botId}`,
          },
        }
      );
      for await (const chunk of response.textStream) {
        answer += chunk;
      }
    } catch (err) {
      console.error('[recall-ask] Agent error:', err);
      return c.json({ error: 'Agent failed to answer. The meeting may not have been processed yet.' }, 500);
    }

    return c.json({ botId, question, answer, sessionId });
  }),
};
