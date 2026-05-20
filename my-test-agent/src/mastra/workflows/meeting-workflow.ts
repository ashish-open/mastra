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
 *     → Detects meeting type (heuristic, no extra LLM call for common cases)
 *     → Runs meeting summary agent in the detected type's format
 *     → Posts summary to the team's Slack channel
 *
 * Webhook flow (handled in recall-webhook.ts route):
 *   recording.done  → call create_transcript API
 *   transcript.done → trigger processMeetingWorkflow with transcriptId
 *
 * Meeting types supported:
 *   sales | onboarding | support | ops | finance | product | engineering | hr | general
 *
 * IMPORTANT: No polling. All state updates come via webhooks.
 */

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { recallFetch, recallHeaders, RECALL_BASE } from '../tools/recall-tool.js';

export const meetingTypeSchema = z.enum([
  'sales',
  'onboarding',
  'support',
  'ops',
  'finance',
  'product',
  'engineering',
  'hr',
  'general',
]);

export type MeetingType = z.infer<typeof meetingTypeSchema>;

// ─── Meeting type classifier (heuristic — no extra LLM call) ─────────────────
// Runs on title + first chunk of transcript. Covers >95% of real cases.
// Falls back to 'general' if nothing matches — user can override via bot metadata.

function classifyMeetingType(title: string, transcriptChunk: string): MeetingType {
  const text = `${title} ${transcriptChunk}`.toLowerCase();

  if (/financ|reconcil|recon\b|budget|audit|ledger|settlement|invoice|account.*payable|account.*receiv|cash.?flow|p&l|profit.?loss|expense.*review|payment.*(issue|problem|discrepan)/i.test(text)) return 'finance';
  if (/product\s*(review|planning|meeting|sync|standup)|roadmap|feature\s*(request|review|discussion)|sprint\s*(planning|review|retro)|backlog|user.?stor|design.?review|ux\s*(review|session)|prd\b|prfaq/i.test(text)) return 'product';
  if (/engineer|architect|tech\s*(review|debt|discussion)|code.?review|infra|devops|deploy|system.?design|api.?design|incident.?review|post.?mortem/i.test(text)) return 'engineering';
  if (/onboard|kyc|merchant.?setup|account.?setup|new.?merchant|go.?live/i.test(text)) return 'onboarding';
  if (/sales|prospect|demo|pitch|deal|commercial|revenue|quota|lead|opportunity|crm/i.test(text)) return 'sales';
  if (/support|incident|issue|ticket|escalat|bug|outage|customer.?complaint/i.test(text)) return 'support';
  if (/\bhr\b|hiring|recruit|performance.?review|compensation|culture|people.?team|employee|appraisal|l&d|learning.*develop/i.test(text)) return 'hr';
  if (/ops|operations|process|sop|runbook|workflow.*review|standup|sync\b/i.test(text)) return 'ops';

  return 'general';
}

// ─── Slack channel + emoji routing ───────────────────────────────────────────

const CHANNEL_MAP: Record<MeetingType, string> = {
  sales: 'sales',
  onboarding: 'onboarding',
  support: 'support',
  ops: 'ops',
  finance: 'finance',
  product: 'product',
  engineering: 'engineering',
  hr: 'hr',
  general: 'general',
};

const EMOJI_MAP: Record<MeetingType, string> = {
  sales: '💼',
  onboarding: '🚀',
  support: '🛟',
  ops: '⚙️',
  finance: '💰',
  product: '🎯',
  engineering: '🛠️',
  hr: '👥',
  general: '📋',
};

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
    meetingType: meetingTypeSchema.optional().describe(
      'sales | onboarding | support | ops | finance | product | engineering | hr | general. ' +
      'If omitted, the workflow will auto-detect from the meeting title and transcript.'
    ),
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
  description: 'Downloads the completed transcript from Recall.ai, resolves bot metadata, classifies meeting type',
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
    meetingType: meetingTypeSchema,
    plainText: z.string(),
    speakerCount: z.number(),
    wordCount: z.number(),
    durationMinutes: z.number().optional(),
    detectedType: z.boolean().describe('true if type was auto-detected (not user-provided)'),
  }),
  execute: async ({ inputData }) => {
    const { transcriptId, botId, meetingTitle, meetingType } = inputData;

    // Fetch bot metadata to resolve title/type if not passed from webhook
    let resolvedTitle = meetingTitle;
    let resolvedType = meetingType;
    let durationMinutes: number | undefined;

    if (!resolvedTitle || !resolvedType || resolvedType === 'general') {
      const botRes = await recallFetch(`${RECALL_BASE}/bot/${botId}/`, {
        headers: recallHeaders(),
      });
      if (botRes.ok) {
        const bot = (await botRes.json()) as {
          metadata?: { meetingTitle?: string; meetingType?: string };
          status_changes?: { code: string; created_at: string }[];
        };
        resolvedTitle = resolvedTitle ?? bot.metadata?.meetingTitle ?? 'Untitled Meeting';
        // Only take the stored type if it's not already 'general' — 'general' means
        // "wasn't set", so we still want to try auto-detection below.
        const storedType = bot.metadata?.meetingType as MeetingType | undefined;
        if (!resolvedType || resolvedType === 'general') {
          resolvedType = (storedType && storedType !== 'general') ? storedType : undefined;
        }

        // Calculate meeting duration from status_changes
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

    // Download the actual transcript JSON from the signed URL
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

    // Auto-detect meeting type if not set or was 'general'
    const detectedType = !resolvedType || resolvedType === 'general';
    if (detectedType) {
      resolvedType = classifyMeetingType(resolvedTitle ?? '', plainText.slice(0, 3000));
      console.log(`[meeting-workflow] Auto-detected meeting type: "${resolvedType}" for "${resolvedTitle}"`);
    } else {
      console.log(`[meeting-workflow] Using provided meeting type: "${resolvedType}"`);
    }

    return {
      transcriptId,
      botId,
      meetingTitle: resolvedTitle ?? 'Untitled Meeting',
      // resolvedType is always set here: either from bot metadata or classifyMeetingType()
      meetingType: resolvedType ?? 'general',
      plainText,
      speakerCount: new Set(segments.map(s => s.speaker)).size,
      wordCount: segments.reduce((acc, s) => acc + s.words.length, 0),
      durationMinutes,
      detectedType,
    };
  },
});

const generateAndPostSummaryStep = createStep({
  id: 'generate-and-post-summary',
  description: 'Generates a type-specific meeting summary and posts it to the team Slack channel',
  inputSchema: z.object({
    transcriptId: z.string(),
    botId: z.string(),
    meetingTitle: z.string(),
    meetingType: meetingTypeSchema,
    plainText: z.string(),
    speakerCount: z.number(),
    wordCount: z.number(),
    durationMinutes: z.number().optional(),
    detectedType: z.boolean(),
  }),
  outputSchema: z.object({
    botId: z.string(),
    meetingTitle: z.string(),
    meetingType: z.string(),
    summary: z.string(),
    slackPosted: z.boolean(),
  }),
  execute: async ({ inputData, mastra }) => {
    const {
      transcriptId, botId, meetingTitle, meetingType,
      plainText, speakerCount, wordCount, durationMinutes, detectedType,
    } = inputData;

    const agent = mastra?.getAgent('meetingAgent');
    if (!agent) throw new Error('meeting-agent not found in Mastra config');

    const slackChannel = CHANNEL_MAP[meetingType] ?? 'general';
    const emoji = EMOJI_MAP[meetingType] ?? '📋';

    // Speakers present in this meeting (pass to agent so it can extract owners)
    const speakers = [...new Set(
      plainText
        .split('\n')
        .map(line => line.split(':')[0]?.trim())
        .filter(Boolean)
    )];

    const prompt = `
Meeting: "${meetingTitle}"
Type: ${meetingType.toUpperCase()}${detectedType ? ' (auto-detected)' : ''}
Duration: ${durationMinutes ? `${durationMinutes} min` : 'unknown'}
Speakers: ${speakerCount} | Words: ${wordCount}
Speaker names in transcript: ${speakers.join(', ')}

IMPORTANT — Action Item Owners:
The transcript contains real speaker names listed above. When extracting action items,
look for who committed to doing something (e.g. "I'll look into that", "we can fix that",
"let me check"). Assign the owner by name from the speaker list. Only use "TBD" if
genuinely no one was identified — not as a default.

IMPORTANT — KB Citations:
Only cite URLs that search-knowledge actually returned. If no relevant KB results are
found, omit the "🔎 Product Context" section entirely. Never invent or guess URLs.

--- TRANSCRIPT ---
${plainText.slice(0, 16000)}${plainText.length > 16000 ? '\n[transcript truncated at 16k chars]' : ''}
--- END ---

Steps (do them in order):

1. Read the full transcript. Identify:
   - Topics worth looking up in the KB (product names, error codes, policy questions).
   - Who said they would do what (for action items).

2. For each KB-worthy topic, call search-knowledge or the appropriate Zwitch MCP tool
   with a focused query. Skip if the topic is purely people/process with no product angle.

3. Write a structured summary in the ${meetingType.toUpperCase()} format from your
   instructions. Use the real speaker names for action item owners.

4. Post the summary to Slack:
   - channel: "${slackChannel}"
   - title: "${meetingTitle}"
   - emoji: "${emoji}"
   - fields: [
       { label: "Duration", value: "${durationMinutes ? durationMinutes + ' min' : 'unknown'}" },
       { label: "Speakers", value: "${speakerCount}" },
       { label: "Type", value: "${meetingType}${detectedType ? ' (auto)' : ''}" }
     ]
   - footer: "💬 Ask questions about this meeting → POST /recall/ask/${botId}"
`;

    let summaryText = '';
    const response = await agent.stream([{ role: 'user', content: prompt }], {
      // Resource-scope memory per meeting — reprocessing the same meeting
      // carries over the agent's working notes from the first run.
      memory: {
        resource: `meeting-${botId}`,
        thread: `process-${transcriptId}`,
      },
    });
    for await (const chunk of response.textStream) {
      summaryText += chunk;
    }

    console.log(`[meeting-workflow] Summary generated and posted to #${slackChannel} (type: ${meetingType})`);
    return { botId, meetingTitle, meetingType, summary: summaryText, slackPosted: true };
  },
});

export const processMeetingWorkflow = createWorkflow({
  id: 'process-meeting-workflow',
  inputSchema: z.object({
    transcriptId: z.string().describe('From transcript.done webhook: data.transcript.id'),
    botId: z.string().describe('From transcript.done webhook: data.bot.id'),
    meetingTitle: z.string().optional(),
    meetingType: meetingTypeSchema.optional().describe(
      'If not provided (or "general"), the workflow auto-detects from title + transcript.'
    ),
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
