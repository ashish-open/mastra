/**
 * Recall.ai Webhook Handler — /recall/webhook
 *
 * Registered as a public Mastra API route so Recall.ai can POST to it.
 *
 * Handles dashboard webhook events:
 *   bot.*         → log bot lifecycle (joining, in_call, done, fatal)
 *   recording.done → kick off async transcription job
 *   transcript.done → trigger processMeetingWorkflow → summary → Slack
 *
 * Security:
 *   - Verifies every request with RECALL_WORKSPACE_VERIFICATION_SECRET
 *   - Rejects unverified requests with 401
 *   - Responds 200 immediately, processes asynchronously (per guide)
 *
 * Webhook URL to register in Recall dashboard (ap-northeast-1):
 *   https://YOUR_NGROK_URL/recall/webhook
 */

import type { ApiRoute } from '@mastra/core/server';
import { verifyRecallWebhook, recallFetch, recallHeaders, RECALL_BASE } from '../tools/recall-tool.js';

// ─── Types (Recall webhook payload shapes) ────────────────────────────────────

interface RecallBotWebhook {
  event: string; // bot.joining_call | bot.in_call_recording | bot.done | bot.fatal | ...
  data: {
    data: { code: string; sub_code?: string | null; updated_at: string };
    bot: { id: string; metadata?: Record<string, string> };
  };
}

interface RecallRecordingDoneWebhook {
  event: 'recording.done';
  data: {
    data: { code: string; sub_code?: string | null; updated_at: string };
    recording: { id: string; metadata?: Record<string, unknown> };
    bot: { id: string; metadata?: Record<string, string> };
  };
}

interface RecallTranscriptDoneWebhook {
  event: 'transcript.done';
  data: {
    data: { code: string; sub_code?: string | null; updated_at: string };
    transcript: { id: string; metadata?: Record<string, unknown> };
    recording: { id: string; metadata?: Record<string, unknown> };
    bot: { id: string; metadata?: Record<string, string> };
  };
}

type RecallWebhookPayload = RecallBotWebhook | RecallRecordingDoneWebhook | RecallTranscriptDoneWebhook;

// ─── Async processor (runs after 200 response is sent) ───────────────────────

async function processWebhook(payload: RecallWebhookPayload, mastra: unknown): Promise<void> {
  const { event } = payload;
  console.log(`[recall-webhook] Processing event: ${event}`);

  // ── Bot lifecycle events ─────────────────────────────────────────────────
  if (event.startsWith('bot.')) {
    const botPayload = payload as RecallBotWebhook;
    const { code } = botPayload.data.data;
    const botId = botPayload.data.bot.id;

    console.log(`[recall-webhook] Bot ${botId}: ${event} (${code})`);

    if (event === 'bot.fatal') {
      console.error(`[recall-webhook] Bot ${botId} fatal error — sub_code: ${botPayload.data.data.sub_code}`);
    }
    return;
  }

  // ── recording.done → start async transcript job ──────────────────────────
  if (event === 'recording.done') {
    const recPayload = payload as RecallRecordingDoneWebhook;
    const recordingId = recPayload.data.recording.id;
    const botId = recPayload.data.bot.id;

    console.log(`[recall-webhook] Recording done: ${recordingId} (bot: ${botId}) — starting transcript job`);

    const res = await recallFetch(`${RECALL_BASE}/recording/${recordingId}/create_transcript/`, {
      method: 'POST',
      headers: recallHeaders(),
      body: JSON.stringify({
        provider: {
          recallai_async: { language_code: 'en' },
        },
        diarization: {
          use_separate_streams_when_available: true,
        },
      }),
    });

    if (!res.ok) {
      console.error(`[recall-webhook] create_transcript failed (${res.status}): ${await res.text()}`);
    } else {
      const data = (await res.json()) as { id: string };
      console.log(`[recall-webhook] Transcript job created: ${data.id}`);
    }
    return;
  }

  // ── transcript.done → trigger processMeetingWorkflow ────────────────────
  if (event === 'transcript.done') {
    const txPayload = payload as RecallTranscriptDoneWebhook;
    const transcriptId = txPayload.data.transcript.id;
    const botId = txPayload.data.bot.id;
    const botMeta = txPayload.data.bot.metadata ?? {};

    console.log(`[recall-webhook] Transcript done: ${transcriptId} (bot: ${botId}) — triggering workflow`);

    // Trigger the processMeetingWorkflow
    const m = mastra as {
      getWorkflow: (id: string) => {
        createRun: (opts?: { runId?: string }) => Promise<{ startAsync: (opts: { inputData: unknown }) => Promise<void> }>;
      } | undefined
    };
    const workflow = m.getWorkflow('processMeetingWorkflow');
    if (!workflow) {
      console.error('[recall-webhook] process-meeting-workflow not found in Mastra instance');
      return;
    }

    const run = await workflow.createRun();
    await run.startAsync({
      inputData: {
        transcriptId,
        botId,
        meetingTitle: botMeta['meetingTitle'],
        meetingType: botMeta['meetingType'],
      },
    });

    console.log(`[recall-webhook] processMeetingWorkflow triggered for transcript ${transcriptId}`);
    return;
  }

  console.log(`[recall-webhook] Unhandled event: ${event} — ignored`);
}

// ─── Route Definition ─────────────────────────────────────────────────────────

export const recallWebhookRoute: ApiRoute = {
  path: '/recall/webhook',
  method: 'POST',
  requiresAuth: false, // public endpoint — verified by HMAC signature instead
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: ({ mastra }): any => Promise.resolve(async (c: any) => {
    // 1. Read raw body (must use raw body for HMAC verification)
    const rawBody = await c.req.text();

    // 2. Verify signature — reject if invalid
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((value: string, key: string) => {
      headers[key.toLowerCase()] = value;
    });

    if (!verifyRecallWebhook(rawBody, headers)) {
      console.warn('[recall-webhook] Signature verification FAILED — rejecting request');
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // 3. Parse payload
    let payload: RecallWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as RecallWebhookPayload;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // 4. Acknowledge immediately (required — Recall.ai retries on non-2xx or timeout)
    // Process asynchronously in background
    void processWebhook(payload, mastra).catch(err => {
      console.error('[recall-webhook] Background processing error:', err);
    });

    // 5. Return 200 immediately
    return c.json({ received: true });
  }),
};
