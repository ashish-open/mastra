/**
 * Meeting Q&A Route — POST /recall/ask/:botId
 *
 * Allows anyone (teams, OpenArc UI, Slack bots) to ask a question about a
 * completed meeting. The meeting agent answers from the transcript stored in
 * meetings.db — NOT from agent memory alone.
 *
 * Why load from DB instead of relying on memory?
 *   Agent memory is scoped to the server process. A restart or a new deploy
 *   wipes it, making Q&A silently useless for older meetings. Loading the full
 *   transcript from meetings.db is reliable regardless of server state.
 *
 * Strategy:
 *   - Fetch the meeting (including full plain_text) from meetings.db.
 *   - Inject the transcript + summary as a SYSTEM-level context block in the
 *     first message of the conversation.
 *   - Use a stable thread key so multi-turn follow-ups stay coherent.
 *   - The agent replies with grounded answers; it does NOT re-summarize.
 *
 * Request:
 *   POST /recall/ask/:botId
 *   Body: { "question": "What was decided about the refund dashboard?", "sessionId"?: "..." }
 *
 * Response:
 *   { "botId": "...", "question": "...", "answer": "...", "sessionId": "...",
 *     "meetingTitle": "...", "meetingType": "..." }
 *
 * Auth: Bearer token via RECALL_RECOVER_SECRET (same as recovery routes).
 */

import type { ApiRoute } from '@mastra/core/server';
import { getMeeting } from '../meetings/db.js';

function authorizeRequest(authHeader: string | undefined): boolean {
  const secret = process.env.RECALL_RECOVER_SECRET;
  if (!secret) {
    console.error('[recall-ask] RECALL_RECOVER_SECRET not set — rejecting request');
    return false;
  }
  return authHeader === `Bearer ${secret}`;
}

/** Build the context block injected as the first message of every Q&A thread. */
function buildMeetingContext(meeting: {
  title: string;
  type: string;
  durationMin: number | null;
  speakerCount: number;
  createdAt: string;
  summaryMd: string | null;
  plainText: string;
}): string {
  const header = [
    `MEETING CONTEXT — for answering the user's question below.`,
    `Title: ${meeting.title}`,
    `Type: ${meeting.type.toUpperCase()}`,
    `Date: ${meeting.createdAt.slice(0, 10)}`,
    meeting.durationMin ? `Duration: ${meeting.durationMin} min` : null,
    `Speakers: ${meeting.speakerCount}`,
  ].filter(Boolean).join('\n');

  const summarySection = meeting.summaryMd
    ? `\n\n--- MEETING SUMMARY ---\n${meeting.summaryMd}`
    : '';

  const transcriptSection = meeting.plainText
    ? `\n\n--- FULL TRANSCRIPT ---\n${meeting.plainText}`
    : '\n\n(No transcript available.)';

  return `${header}${summarySection}${transcriptSection}`;
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

    // Load the meeting from DB — this is the source of truth for the transcript.
    const meeting = await getMeeting(botId);
    if (!meeting) {
      return c.json({
        error: `Meeting ${botId} not found. Either it hasn't been processed yet or the botId is wrong.`,
      }, 404);
    }
    if (!meeting.plainText) {
      return c.json({
        error: `Meeting ${botId} has no transcript stored. Try reprocessing it via POST /recall/reprocess/${botId}.`,
      }, 422);
    }

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

    console.log(`[recall-ask] Q&A — bot: ${botId} ("${meeting.title}"), session: ${sessionId}, q: "${question.slice(0, 80)}"`);

    // Build the context block once per thread. The meeting agent's instructions
    // tell it to answer Q&A ONLY from the transcript — injecting it here ensures
    // it's available even after a server restart (no dependency on agent memory).
    const contextBlock = buildMeetingContext(meeting);

    // Use a stable thread key: qa-{sessionId}-{botId}
    // First message in the thread includes the full transcript context.
    // Subsequent messages in the same session are just the user's questions.
    const threadId = `qa-${sessionId}-${botId}`;
    const resourceId = `meeting-${botId}`;

    let answer = '';
    try {
      const response = await agent.stream(
        [
          // System-level context: inject transcript + summary so the agent can answer
          // grounded questions regardless of whether it has prior memory of this meeting.
          { role: 'system', content: contextBlock },
          { role: 'user', content: question },
        ],
        {
          memory: {
            resource: resourceId,
            thread: threadId,
          },
        }
      );
      for await (const chunk of response.textStream) {
        answer += chunk;
      }
    } catch (err) {
      console.error('[recall-ask] Agent error:', err);
      return c.json({ error: 'Agent failed to answer. Check server logs for details.' }, 500);
    }

    return c.json({
      botId,
      question,
      answer,
      sessionId,
      meetingTitle: meeting.title,
      meetingType: meeting.type,
    });
  }),
};
