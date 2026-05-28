/**
 * Recall.ai Meeting Bot Tools
 *
 * Region: ap-northeast-1 (Japan) — all API calls use regional subdomain.
 *
 * Required env vars:
 *   RECALL_API_KEY                     — from ap-northeast-1.recall.ai/dashboard/developers/api-keys
 *   RECALL_WORKSPACE_VERIFICATION_SECRET — same page, Verification Secret section
 *   PUBLIC_API_BASE_URL                — stable ngrok/production URL (NOT localhost)
 *
 * Implements all required practices from the Recall.ai agent guide:
 *   ✓ Retry logic for 429 / 503 / 507
 *   ✓ Webhook signature verification (HMAC-SHA256)
 *   ✓ Async transcription flow (recording.done → create_transcript → transcript.done)
 *   ✗ No polling (antipattern per guide)
 */

import { createTool } from '@mastra/core/tools';
import { createHmac } from 'crypto';
import { z } from 'zod';

export const RECALL_REGION = 'ap-northeast-1';
export const RECALL_BASE = `https://${RECALL_REGION}.recall.ai/api/v1`;

// ─── Retry-safe fetch (required by Recall.ai guide) ──────────────────────────

export async function recallFetch(
  url: string,
  options: RequestInit,
  maxAttempts = 6,
): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, options);

    let waitSeconds: number | null = null;
    if (response.status === 429) {
      waitSeconds = parseInt(response.headers.get('Retry-After') ?? '5', 10);
    } else if (response.status === 503) {
      waitSeconds = 10;
    } else if (response.status === 507) {
      waitSeconds = 30;
    }

    if (waitSeconds !== null) {
      const jitter = Math.ceil(Math.random() * 5);
      const delay = (waitSeconds + jitter) * 1000;
      console.warn(`[recall] Rate limit (${response.status}), retrying in ${waitSeconds + jitter}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    return response;
  }
  throw new Error(`[recall] Max retry attempts (${maxAttempts}) reached for ${url}`);
}

export function recallHeaders(): Record<string, string> {
  const key = process.env.RECALL_API_KEY;
  if (!key) throw new Error('RECALL_API_KEY env var is not set');
  return {
    Authorization: `Token ${key}`,
    'Content-Type': 'application/json',
  };
}

// ─── Webhook Signature Verification ──────────────────────────────────────────
// Per guide: verify EVERY request from Recall.ai before processing.
// Uses RECALL_WORKSPACE_VERIFICATION_SECRET for dashboard webhooks
// (account created after Dec 15, 2025 → workspace secret only, no Svix secret).

export function verifyRecallWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
): boolean {
  const secret = process.env.RECALL_WORKSPACE_VERIFICATION_SECRET;
  if (!secret) {
    console.error('[recall] RECALL_WORKSPACE_VERIFICATION_SECRET not set — rejecting webhook');
    return false;
  }

  // Recall.ai uses Svix for webhook delivery.
  // Svix signs: "{webhook-id}.{webhook-timestamp}.{raw-body}"
  // Key: base64-decode the part after "whsec_"
  // Header: webhook-signature = "v1,<base64>" (may have multiple space-separated values)

  const msgId = headers['webhook-id'];
  const msgTimestamp = headers['webhook-timestamp'];
  const msgSignature = headers['webhook-signature'];

  if (!msgId || !msgTimestamp || !msgSignature) {
    console.error('[recall] Missing Svix headers (webhook-id / webhook-timestamp / webhook-signature)');
    return false;
  }

  // Decode the signing key
  const keyBase64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const keyBytes = Buffer.from(keyBase64, 'base64');

  // Build the signed content
  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`;

  // Compute expected signature
  const computedB64 = createHmac('sha256', keyBytes).update(signedContent).digest('base64');

  // webhook-signature may contain multiple space-separated "v1,<base64>" values
  const signatures = msgSignature.split(' ');
  for (const sig of signatures) {
    const [version, value] = sig.split(',');
    if (version !== 'v1' || !value) continue;

    const a = Buffer.from(value, 'base64');
    const b = Buffer.from(computedB64, 'base64');
    if (a.length === b.length) {
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      if (diff === 0) return true;
    }
  }

  console.error('[recall] ❌ Svix signature mismatch');
  return false;
}

// ─── Tool: Deploy Bot ─────────────────────────────────────────────────────────

export const deployMeetingBot = createTool({
  id: 'deploy-meeting-bot',
  description:
    'Sends a Recall.ai bot into a Google Meet, Zoom, or Teams meeting to record and transcribe. Returns the botId. The bot posts a chat message on join so participants know they are being recorded.',
  inputSchema: z.object({
    meetingUrl: z.string().describe('Full meeting URL'),
    joinAt: z.string().optional().describe('ISO 8601 time for bot to join. Defaults to now.'),
    botName: z.string().default('Note Taker AI').describe('Display name in the meeting'),
    meetingTitle: z.string().optional().describe('For tracking/routing only — stored in bot metadata'),
    meetingType: z
      .enum(['sales', 'onboarding', 'support', 'ops', 'general'])
      .optional()
      .describe('Meeting type for routing the summary to the right Slack channel'),
  }),
  execute: async ({ meetingUrl, joinAt, botName, meetingTitle, meetingType }) => {
    const publicUrl = process.env.PUBLIC_API_BASE_URL;
    if (!publicUrl || publicUrl.includes('localhost')) {
      throw new Error(
        'PUBLIC_API_BASE_URL must be a stable public URL (e.g. ngrok). localhost is rejected by Recall.ai.',
      );
    }

    // recording_config does several things at once:
    //   • transcript: post-meeting transcription auto-starts when recording finishes
    //     — no separate create_transcript call needed (removes a failure mode).
    //   • audio_mixed_mp3: archival audio so we can re-transcribe with a different
    //     provider if recallai_async fails.
    //   • meeting_metadata: get the platform's real meeting title (e.g. from Zoom),
    //     better than our locally-supplied label.
    //   • participant_events: join/leave timestamps for accurate attendance.
    // Language 'auto' enables auto-detect + code-switching (matters for IN calls
    // that mix English + Hindi/Marathi).
    const body = {
      meeting_url: meetingUrl,
      join_at: joinAt ?? new Date().toISOString(),
      bot_name: botName ?? 'Note Taker AI',
      // Auto-leave when the bot is alone or the call goes silent.
      // Without this, bots can sit forever if the host mutes them and walks away.
      automatic_leave: {
        // Leave 2 minutes after being the only one in the call
        only_participant_in_meeting_timeout: 120,
        // Leave 30 minutes after the meeting started if nobody else joined
        waiting_room_timeout: 1800,
        // Leave 10 minutes after the bot is the only audio source
        silence_detection: { timeout: 600, activate_after: 60 },
      },
      recording_config: {
        transcript: {
          provider: {
            recallai_async: { language_code: 'auto' },
          },
          diarization: {
            // Perfect diarization — returns real participant names, not "Speaker A".
            // Works on Zoom, Teams, Google Meet (not Webex).
            use_separate_streams_when_available: true,
          },
        },
        audio_mixed_mp3: {},
        meeting_metadata: {},
        participant_events: {},
      },
      chat: {
        on_bot_join: {
          send_to: 'everyone',
          message: 'This meeting is being recorded and transcribed by Note Taker AI.',
          // Note: pin only works on Google Meet. Zoom and Teams ignore it.
          pin: true,
        },
      },
      // Metadata stored on the bot — retrieved in webhook handler.
      // Recall enforces string-only values, ≤500 chars per value.
      metadata: {
        meetingTitle: (meetingTitle ?? 'Untitled Meeting').slice(0, 500),
        meetingType: meetingType ?? 'general',
      },
    };

    const res = await recallFetch(`${RECALL_BASE}/bot/`, {
      method: 'POST',
      headers: recallHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Recall.ai create bot failed (${res.status}): ${err}`);
    }

    const data = (await res.json()) as { id: string };
    console.log(`[recall] Bot deployed: ${data.id} → ${meetingUrl}`);

    return {
      botId: data.id,
      meetingUrl,
      meetingTitle: meetingTitle ?? 'Untitled Meeting',
      meetingType: meetingType ?? 'general',
    };
  },
});

// ─── Tool: Create Async Transcript ───────────────────────────────────────────
// NOTE: With recording_config.transcript set on bot creation, Recall auto-creates
// the transcript when recording finishes. This tool is kept for the recovery flow
// (when a webhook is missed, or when retrying a failed transcript with a fallback
// provider). It also supports provider override for retry-with-different-provider.

const ASYNC_PROVIDERS = ['recallai_async', 'deepgram_async', 'assembly_ai_async'] as const;
type AsyncProvider = (typeof ASYNC_PROVIDERS)[number];

export async function startAsyncTranscript(
  recordingId: string,
  provider: AsyncProvider = 'recallai_async',
  languageCode: string = 'auto',
): Promise<{ transcriptId: string; recordingId: string; provider: AsyncProvider }> {
  // Each provider has slightly different config shape; we only set language_code.
  // recallai_async + deepgram_async + assembly_ai_async all accept it.
  const providerBody: Record<string, { language_code?: string }> = {};
  providerBody[provider] = provider === 'assembly_ai_async'
    ? {} // AssemblyAI uses different fields; default model handles language detection
    : { language_code: languageCode };

  const res = await recallFetch(`${RECALL_BASE}/recording/${recordingId}/create_transcript/`, {
    method: 'POST',
    headers: recallHeaders(),
    body: JSON.stringify({
      provider: providerBody,
      diarization: { use_separate_streams_when_available: true },
    }),
  });

  if (!res.ok) {
    throw new Error(`Recall.ai create_transcript failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  console.log(`[recall] Transcript job started: ${data.id} for recording ${recordingId} (provider: ${provider})`);
  return { transcriptId: data.id, recordingId, provider };
}

export const createAsyncTranscript = createTool({
  id: 'create-async-transcript',
  description:
    'Starts a post-meeting transcript job for a completed recording. Use only in recovery flows — normal meetings auto-transcribe via recording_config on bot creation.',
  inputSchema: z.object({
    recordingId: z.string().describe('Recording ID from the recording.done webhook payload'),
    provider: z.enum(ASYNC_PROVIDERS).default('recallai_async').describe('Fallback provider for retries'),
    languageCode: z.string().default('auto').describe('Language code or "auto" for detection'),
  }),
  execute: async ({ recordingId, provider, languageCode }) => {
    const result = await startAsyncTranscript(
      recordingId,
      provider as AsyncProvider,
      languageCode,
    );
    return { transcriptId: result.transcriptId, recordingId: result.recordingId };
  },
});

// ─── Tool: Fetch Transcript ───────────────────────────────────────────────────
// Called after transcript.done webhook. Downloads the full transcript JSON.

export const fetchTranscriptById = createTool({
  id: 'fetch-transcript-by-id',
  description:
    'Downloads the full transcript for a completed transcript job. Call this after receiving the transcript.done webhook.',
  inputSchema: z.object({
    transcriptId: z.string().describe('Transcript ID from the transcript.done webhook payload'),
  }),
  execute: async ({ transcriptId }) => {
    // Step 1: Get transcript metadata (includes download_url)
    const metaRes = await recallFetch(`${RECALL_BASE}/transcript/${transcriptId}/`, {
      headers: recallHeaders(),
    });

    if (!metaRes.ok) {
      throw new Error(`Recall.ai retrieve transcript failed (${metaRes.status}): ${await metaRes.text()}`);
    }

    const meta = (await metaRes.json()) as {
      id: string;
      data: { download_url: string };
    };

    // Step 2: Download the actual transcript JSON from the signed URL
    const dlRes = await fetch(meta.data.download_url);
    if (!dlRes.ok) {
      throw new Error(`Transcript download failed (${dlRes.status})`);
    }

    const transcript = (await dlRes.json()) as Array<{
      speaker?: string | null;
      participant?: { id?: number; name?: string; is_host?: boolean } | null;
      words: { text: string; start_timestamp?: { relative: number }; end_timestamp?: { relative?: number } | null }[];
    }>;

    // Recall uses `participant.name` for separate-stream transcription (speaker is null).
    // Fall back to `speaker` for legacy/real-time transcription, then "Unknown".
    function resolveSegmentSpeaker(seg: typeof transcript[0]): string {
      const name = seg.participant?.name?.trim();
      if (name && name.length > 0) return name;
      const sp = seg.speaker?.trim();
      if (sp && sp.length > 0) return sp;
      return 'Unknown';
    }

    // Convert to readable plain text grouped by speaker
    const plainText = transcript
      .map(seg => {
        const text = seg.words.map(w => w.text).join(' ').trim();
        const speaker = resolveSegmentSpeaker(seg);
        return text.length > 5 ? `${speaker}: ${text}` : null;
      })
      .filter(Boolean)
      .join('\n') as string;

    const speakers = new Set(transcript.map(s => resolveSegmentSpeaker(s)));
    const wordCount = transcript.reduce((acc, s) => acc + s.words.length, 0);

    return {
      transcriptId,
      plainText,
      speakerCount: speakers.size,
      wordCount,
      rawSegments: transcript,
    };
  },
});
