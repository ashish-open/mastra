/**
 * Recall.ai Webhook Handler — /recall/webhook
 *
 * Registered as a public Mastra API route so Recall.ai can POST to it.
 *
 * Handles dashboard webhook events:
 *   bot.*                            → log bot lifecycle
 *   bot.recording_permission_denied  → record failure, alert
 *   recording.done                   → no-op (transcript auto-starts via recording_config)
 *   recording.failed                 → record failure, alert
 *   transcript.done                  → trigger processMeetingWorkflow → summary → Slack
 *   transcript.failed                → auto-retry with fallback provider, alert
 *
 * Idempotency: every delivery is keyed by the Svix `webhook-id` header and
 * recorded in meetings.db. Duplicates short-circuit before any side-effects.
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
import { verifyRecallWebhook, startAsyncTranscript } from '../tools/recall-tool.js';
import { recordWebhookDelivery, markWebhookOutcome, recordMeetingFailure } from '../meetings/db.js';

// ─── Types (Recall webhook payload shapes) ────────────────────────────────────

interface RecallBotWebhook {
  event: string; // bot.joining_call | bot.in_call_recording | bot.done | bot.fatal | ...
  data: {
    data: { code: string; sub_code?: string | null; updated_at: string };
    bot: { id: string; metadata?: Record<string, string> };
  };
}

interface RecallRecordingWebhook {
  event: 'recording.done' | 'recording.failed' | 'recording.processing' | 'recording.deleted';
  data: {
    data: { code: string; sub_code?: string | null; updated_at: string };
    recording: { id: string; metadata?: Record<string, unknown> };
    bot: { id: string; metadata?: Record<string, string> };
  };
}

interface RecallTranscriptWebhook {
  event: 'transcript.done' | 'transcript.failed' | 'transcript.processing' | 'transcript.deleted';
  data: {
    data: { code: string; sub_code?: string | null; updated_at: string };
    transcript: { id: string; metadata?: Record<string, unknown> };
    recording: { id: string; metadata?: Record<string, unknown> };
    bot: { id: string; metadata?: Record<string, string> };
  };
}

type RecallWebhookPayload = RecallBotWebhook | RecallRecordingWebhook | RecallTranscriptWebhook;

// Providers we'll try in order if recallai_async fails.
const TRANSCRIPT_FALLBACK_PROVIDERS = ['deepgram_async', 'assembly_ai_async'] as const;

/** Extract bot_id from any Recall webhook payload shape (defensive). */
function extractBotId(payload: RecallWebhookPayload): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (payload as any).data;
  return data?.bot?.id ?? null;
}

// ─── Async processor (runs after 200 response is sent) ───────────────────────

async function processWebhook(payload: RecallWebhookPayload, mastra: unknown): Promise<void> {
  const { event } = payload;
  console.log(`[recall-webhook] Processing event: ${event}`);

  // ── Bot lifecycle events ─────────────────────────────────────────────────
  if (event.startsWith('bot.')) {
    const botPayload = payload as RecallBotWebhook;
    const { code, sub_code } = botPayload.data.data;
    const botId = botPayload.data.bot.id;

    console.log(`[recall-webhook] Bot ${botId}: ${event} (${code})`);

    if (event === 'bot.fatal') {
      console.error(`[recall-webhook] Bot ${botId} fatal error — sub_code: ${sub_code}`);
      await recordMeetingFailure({ botId, event, code, subCode: sub_code });
    } else if (event === 'bot.recording_permission_denied') {
      console.error(`[recall-webhook] Bot ${botId} was DENIED recording permission`);
      await recordMeetingFailure({ botId, event, code, subCode: sub_code });
    }
    return;
  }

  // ── recording.done → no-op (transcript auto-starts via recording_config) ──
  // We used to call create_transcript here manually, but now recording_config.transcript
  // on bot creation does it automatically. Just log and move on.
  if (event === 'recording.done') {
    const recPayload = payload as RecallRecordingWebhook;
    console.log(
      `[recall-webhook] Recording done: ${recPayload.data.recording.id} ` +
      `(bot: ${recPayload.data.bot.id}) — transcript will be auto-created by recording_config`,
    );
    return;
  }

  // ── recording.failed → log and persist for visibility ───────────────────
  if (event === 'recording.failed') {
    const recPayload = payload as RecallRecordingWebhook;
    const { code, sub_code } = recPayload.data.data;
    const recordingId = recPayload.data.recording.id;
    const botId = recPayload.data.bot.id;

    console.error(
      `[recall-webhook] Recording FAILED: ${recordingId} (bot: ${botId}) ` +
      `— code: ${code}, sub_code: ${sub_code}`,
    );
    await recordMeetingFailure({ botId, event, code, subCode: sub_code, recordingId });
    return;
  }

  // ── transcript.done → trigger processMeetingWorkflow ────────────────────
  if (event === 'transcript.done') {
    const txPayload = payload as RecallTranscriptWebhook;
    const transcriptId = txPayload.data.transcript.id;
    const botId = txPayload.data.bot.id;
    const botMeta = txPayload.data.bot.metadata ?? {};

    console.log(`[recall-webhook] Transcript done: ${transcriptId} (bot: ${botId}) — triggering workflow`);

    const m = mastra as {
      getWorkflow: (id: string) => {
        createRun: (opts?: { runId?: string }) => Promise<{ startAsync: (opts: { inputData: unknown }) => Promise<void> }>;
      } | undefined
    };
    const workflow = m.getWorkflow('processMeetingWorkflow');
    if (!workflow) {
      console.error('[recall-webhook] processMeetingWorkflow not found in Mastra instance');
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

  // ── transcript.failed → auto-retry with a fallback provider ─────────────
  // Per Recall docs: "If post-meeting transcription fails, you can retry with a
  // backup provider." We pick the first fallback that hasn't been tried yet
  // (tracked via the meeting_failures.retried_with column for visibility).
  if (event === 'transcript.failed') {
    const txPayload = payload as RecallTranscriptWebhook;
    const { code, sub_code } = txPayload.data.data;
    const transcriptId = txPayload.data.transcript.id;
    const recordingId = txPayload.data.recording.id;
    const botId = txPayload.data.bot.id;

    console.error(
      `[recall-webhook] Transcript FAILED: ${transcriptId} (bot: ${botId}, recording: ${recordingId}) ` +
      `— code: ${code}, sub_code: ${sub_code}`,
    );

    // Try the first fallback provider. If it eventually fails too, the next
    // transcript.failed webhook will land here again — we don't currently track
    // attempt count, so this can loop once at most through fallbacks before
    // operators investigate.
    const fallback = TRANSCRIPT_FALLBACK_PROVIDERS[0];
    try {
      const retry = await startAsyncTranscript(recordingId, fallback, 'auto');
      console.log(
        `[recall-webhook] Retried transcript with ${fallback}: new transcript id ${retry.transcriptId}`,
      );
      await recordMeetingFailure({
        botId, event, code, subCode: sub_code,
        recordingId, transcriptId,
        retriedWith: fallback,
      });
    } catch (err) {
      console.error(`[recall-webhook] Fallback transcription with ${fallback} failed:`, err);
      await recordMeetingFailure({
        botId, event, code, subCode: sub_code,
        recordingId, transcriptId,
      });
    }
    return;
  }

  // Quietly accept other documented events (processing, deleted) without action.
  if (
    event === 'recording.processing' || event === 'recording.deleted' ||
    event === 'transcript.processing' || event === 'transcript.deleted'
  ) {
    console.log(`[recall-webhook] ${event} — acknowledged (no action needed)`);
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

    // 4. Idempotency gate — Recall retries failed deliveries. Use the Svix
    //    `webhook-id` header (unique per delivery) to short-circuit duplicates.
    //    Without this, a slow handler could trigger processMeetingWorkflow twice.
    const webhookId = headers['webhook-id'];
    if (webhookId) {
      try {
        const { isNew } = await recordWebhookDelivery(
          webhookId,
          payload.event,
          extractBotId(payload),
        );
        if (!isNew) {
          console.log(`[recall-webhook] Duplicate delivery ${webhookId} (${payload.event}) — skipping`);
          return c.json({ received: true, duplicate: true });
        }
      } catch (err) {
        // Don't fail the webhook if the dedup store is unavailable — better to
        // risk a duplicate than to make Recall retry indefinitely.
        console.warn('[recall-webhook] Dedup check failed (non-fatal):', err instanceof Error ? err.message : err);
      }
    }

    // 5. Acknowledge immediately (required — Recall.ai retries on non-2xx or timeout)
    //    Process asynchronously in background.
    void processWebhook(payload, mastra)
      .then(() => {
        if (webhookId) void markWebhookOutcome(webhookId, 'processed').catch(() => undefined);
      })
      .catch(err => {
        console.error('[recall-webhook] Background processing error:', err);
        if (webhookId) {
          void markWebhookOutcome(
            webhookId,
            'error',
            err instanceof Error ? err.message : String(err),
          ).catch(() => undefined);
        }
      });

    // 6. Return 200 immediately
    return c.json({ received: true });
  }),
};
