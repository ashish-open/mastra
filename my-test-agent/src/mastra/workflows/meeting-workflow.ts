/**
 * Meeting Bot Workflows — Recall.ai (ap-northeast-1)
 *
 * Flow (per official Recall.ai async transcription guide):
 *
 *  1. deployMeetingBotWorkflow
 *     Trigger manually with a meeting URL.
 *     → Sends bot into meeting via Recall.ai
 *     → Bot posts a "recording in progress" chat message
 *     → Returns botId
 *
 *  2. processMeetingWorkflow
 *     Triggered by Recall.ai webhook when transcript is ready.
 *     → Input: transcriptId + botId (from transcript.done webhook)
 *     → Downloads transcript from Recall.ai
 *     → Runs meeting summary agent (GPT-4o)
 *     → Posts summary to correct Slack channel
 *
 * Webhook flow (handled in recall-webhook.ts route):
 *   recording.done  → call create_transcript API
 *   transcript.done → trigger processMeetingWorkflow with transcriptId
 *
 * IMPORTANT: No polling. All state updates come via webhooks.
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { recallFetch, recallHeaders, RECALL_BASE } from '../tools/recall-tool.js';

const meetingTypeSchema = z.enum(['sales', 'onboarding', 'support', 'ops', 'general']);

// ─── Workflow 1: Deploy Bot ───────────────────────────────────────────────────

const deployBotStep = createStep({
  id: 'deploy-bot',
  description: 'Sends a Recall.ai bot into a meeting to record and transcribe',
  inputSchema: z.object({
    meetingUrl: z.string(),
    joinAt: z.string().optional(),
    meetingTitle: z.string().optional(),
    meetingType: meetingTypeSchema.optional(),
    botName: z.string().optional(),
  }),
  outputSchema: z.object({
    botId: z.string(),
    meetingUrl: z.string(),
    meetingTitle: z.string(),
    meetingType: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { meetingUrl, joinAt, meetingTitle, meetingType, botName } = inputData;

    const publicUrl = process.env.PUBLIC_API_BASE_URL;
    if (!publicUrl || publicUrl.includes('localhost')) {
      throw new Error(
        'PUBLIC_API_BASE_URL must be a stable public URL (ngrok or production). ' +
        'localhost is blocked by Recall.ai with a 403 error.'
      );
    }

    const res = await recallFetch(`${RECALL_BASE}/bot/`, {
      method: 'POST',
      headers: recallHeaders(),
      body: JSON.stringify({
        meeting_url: meetingUrl,
        join_at: joinAt ?? new Date().toISOString(),
        bot_name: botName ?? 'Note Taker AI',
        chat: {
          on_bot_join: {
            send_to: 'everyone',
            message: 'This meeting is being recorded and transcribed by Note Taker AI.',
            pin: true,
          },
        },
        metadata: {
          meetingTitle: meetingTitle ?? 'Untitled Meeting',
          meetingType: meetingType ?? 'general',
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Recall.ai create bot failed (${res.status}): ${err}`);
    }

    const data = (await res.json()) as { id: string };
    console.log(`[meeting-workflow] Bot deployed: ${data.id}`);

    return {
      botId: data.id,
      meetingUrl,
      meetingTitle: meetingTitle ?? 'Untitled Meeting',
      meetingType: meetingType ?? 'general',
    };
  },
});

export const deployMeetingBotWorkflow = createWorkflow({
  id: 'deploy-meeting-bot-workflow',
  inputSchema: z.object({
    meetingUrl: z.string().describe('Full Google Meet / Zoom / Teams URL'),
    joinAt: z.string().optional().describe('ISO 8601 datetime for bot to join (default: now)'),
    meetingTitle: z.string().optional().describe('Label for this meeting (shown in Slack summary)'),
    meetingType: meetingTypeSchema.optional().describe('Routes summary to correct Slack channel'),
    botName: z.string().optional().describe('Override display name in meeting (default: Note Taker AI)'),
  }),
  outputSchema: z.object({
    botId: z.string(),
    meetingUrl: z.string(),
    meetingTitle: z.string(),
    meetingType: z.string(),
  }),
}).then(deployBotStep);

deployMeetingBotWorkflow.commit();

// ─── Workflow 2: Process Meeting (triggered by transcript.done webhook) ───────

const downloadTranscriptStep = createStep({
  id: 'download-transcript',
  description: 'Downloads the completed transcript from Recall.ai using the transcript ID',
  inputSchema: z.object({
    transcriptId: z.string(),
    botId: z.string(),
    meetingTitle: z.string().optional(),
    meetingType: meetingTypeSchema.optional(),
  }),
  outputSchema: z.object({
    transcriptId: z.string(),
    botId: z.string(),
    meetingTitle: z.string(),
    meetingType: z.string(),
    plainText: z.string(),
    speakerCount: z.number(),
    wordCount: z.number(),
    durationMinutes: z.number().optional(),
  }),
  execute: async ({ inputData }) => {
    const { transcriptId, botId, meetingTitle, meetingType } = inputData;

    // Fetch bot metadata to get meetingTitle/meetingType if not passed
    let resolvedTitle = meetingTitle;
    let resolvedType = meetingType;
    let durationMinutes: number | undefined;

    if (!resolvedTitle || !resolvedType) {
      const botRes = await recallFetch(`${RECALL_BASE}/bot/${botId}/`, {
        headers: recallHeaders(),
      });
      if (botRes.ok) {
        const bot = (await botRes.json()) as {
          metadata?: { meetingTitle?: string; meetingType?: string };
          status_changes?: { code: string; created_at: string }[];
        };
        resolvedTitle = resolvedTitle ?? bot.metadata?.meetingTitle ?? 'Untitled Meeting';
        resolvedType = (resolvedType ?? bot.metadata?.meetingType ?? 'general') as z.infer<typeof meetingTypeSchema>;

        // Calculate duration
        const changes = bot.status_changes ?? [];
        const inCall = changes.find(s => s.code === 'in_call_recording');
        const ended = changes.find(s => ['done', 'call_ended'].includes(s.code));
        if (inCall && ended) {
          durationMinutes = Math.round(
            (new Date(ended.created_at).getTime() - new Date(inCall.created_at).getTime()) / 60000
          );
        }
      }
    }

    // Get transcript metadata (contains download_url)
    const metaRes = await recallFetch(`${RECALL_BASE}/transcript/${transcriptId}/`, {
      headers: recallHeaders(),
    });
    if (!metaRes.ok) {
      throw new Error(`Failed to fetch transcript metadata: ${await metaRes.text()}`);
    }

    const meta = (await metaRes.json()) as {
      id: string;
      data: { download_url: string };
    };

    // Download the actual transcript JSON
    const dlRes = await fetch(meta.data.download_url);
    if (!dlRes.ok) throw new Error(`Transcript download failed (${dlRes.status})`);

    const segments = (await dlRes.json()) as Array<{
      speaker: string;
      words: { text: string }[];
    }>;

    const plainText = segments
      .map(seg => {
        const text = seg.words.map(w => w.text).join(' ').trim();
        return text.length > 5 ? `${seg.speaker}: ${text}` : null;
      })
      .filter(Boolean)
      .join('\n') as string;

    return {
      transcriptId,
      botId,
      meetingTitle: resolvedTitle ?? 'Untitled Meeting',
      meetingType: resolvedType ?? 'general',
      plainText,
      speakerCount: new Set(segments.map(s => s.speaker)).size,
      wordCount: segments.reduce((acc, s) => acc + s.words.length, 0),
      durationMinutes,
    };
  },
});

const generateAndPostSummaryStep = createStep({
  id: 'generate-and-post-summary',
  description: 'Generates a structured meeting summary and posts it to Slack',
  inputSchema: z.object({
    transcriptId: z.string(),
    botId: z.string(),
    meetingTitle: z.string(),
    meetingType: z.string(),
    plainText: z.string(),
    speakerCount: z.number(),
    wordCount: z.number(),
    durationMinutes: z.number().optional(),
  }),
  outputSchema: z.object({
    botId: z.string(),
    meetingTitle: z.string(),
    meetingType: z.string(),
    summary: z.string(),
    slackPosted: z.boolean(),
  }),
  execute: async ({ inputData, mastra }) => {
    const { transcriptId, botId, meetingTitle, meetingType, plainText, speakerCount, wordCount, durationMinutes } = inputData;

    const agent = mastra?.getAgent('meetingAgent');
    if (!agent) throw new Error('meeting-agent not found in Mastra config');

    const channelMap: Record<string, string> = {
      sales: 'sales',
      onboarding: 'onboarding',
      support: 'support',
      ops: 'ops',
      general: 'general',
    };
    const emojiMap: Record<string, string> = {
      sales: '💼', onboarding: '🚀', support: '🛟', ops: '⚙️', general: '📋',
    };

    const slackChannel = channelMap[meetingType] ?? 'general';
    const emoji = emojiMap[meetingType] ?? '📋';

    const prompt = `
Meeting: "${meetingTitle}"
Type: ${meetingType.toUpperCase()}
Duration: ${durationMinutes ? `${durationMinutes} min` : 'unknown'}
Speakers: ${speakerCount} | Words: ${wordCount}

--- TRANSCRIPT ---
${plainText.slice(0, 14000)}${plainText.length > 14000 ? '\n[truncated]' : ''}
--- END ---

Steps (do them in order):

1. Read the full transcript and identify product topics, customer questions,
   error codes, or policy questions that are worth looking up in the KB.

2. For each topic identified in step 1, call search-knowledge with a focused
   query and the right product filter (optotax / zwitch / open-money). Skip
   the lookup if the topic is purely internal/people-related.

3. Write a structured summary in the ${meetingType.toUpperCase()} format,
   ending with the "🔎 Product Context (from KB)" section that cites the
   filenames returned by search-knowledge. Skip that section if no useful
   matches were found — never fabricate citations.

4. Post the summary to Slack via post-to-slack:
   - channel: "${slackChannel}"
   - title: "${meetingTitle}"
   - emoji: "${emoji}"
   - fields: [{ label: "Duration", value: "${durationMinutes ? durationMinutes + ' min' : 'unknown'}" }, { label: "Speakers", value: "${speakerCount}" }, { label: "Type", value: "${meetingType}" }]
`;

    // Resource-scope memory PER MEETING (botId) so a re-run on the same
    // meeting carries over the working-memory notes built up the first time.
    let summaryText = '';
    const response = await agent.stream([{ role: 'user', content: prompt }], {
      memory: {
        resource: `meeting-${botId}`,
        thread: `process-${transcriptId}`,
      },
    });
    for await (const chunk of response.textStream) {
      summaryText += chunk;
    }

    console.log(`[meeting-workflow] Summary posted to #${slackChannel}`);
    return { botId, meetingTitle, meetingType, summary: summaryText, slackPosted: true };
  },
});

export const processMeetingWorkflow = createWorkflow({
  id: 'process-meeting-workflow',
  inputSchema: z.object({
    transcriptId: z.string().describe('From transcript.done webhook: data.transcript.id'),
    botId: z.string().describe('From transcript.done webhook: data.bot.id'),
    meetingTitle: z.string().optional(),
    meetingType: meetingTypeSchema.optional(),
  }),
  outputSchema: z.object({
    botId: z.string(),
    meetingTitle: z.string(),
    meetingType: z.string(),
    summary: z.string(),
    slackPosted: z.boolean(),
  }),
})
  .then(downloadTranscriptStep)
  .then(generateAndPostSummaryStep);

processMeetingWorkflow.commit();
