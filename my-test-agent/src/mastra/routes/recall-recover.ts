/**
 * Recall.ai Recovery Routes
 *
 * These routes handle the case where a bot completed its recording but the
 * recording.done or transcript.done webhook was missed (e.g. ngrok tunnel
 * went down between meeting end and Recall firing the webhook).
 *
 * POST /recall/recover/:botId
 *   → Fetches the bot's recordings, kicks off async transcription for any
 *     recording that doesn't already have a transcript. Once Recall finishes
 *     transcription it fires transcript.done → the normal webhook handler
 *     picks it up and runs processMeetingWorkflow.
 *
 * POST /recall/reprocess/:botId
 *   → Skips re-transcription. Fetches the bot's EXISTING transcript and
 *     directly triggers processMeetingWorkflow. Use this when the transcript
 *     IS done (visible in Recall dashboard) but the workflow was never run.
 *
 * These are internal-only routes. Add RECALL_RECOVER_SECRET to .env and pass
 * it as Authorization: Bearer <secret> to prevent accidental triggers.
 */

import type { ApiRoute } from '@mastra/core/server';
import { recallFetch, recallHeaders, RECALL_BASE } from '../tools/recall-tool.js';

// ─── Auth helper ──────────────────────────────────────────────────────────────

function authorizeRequest(authHeader: string | undefined): boolean {
  const secret = process.env.RECALL_RECOVER_SECRET;
  // If no secret is configured, reject all requests (fail-safe)
  if (!secret) {
    console.error('[recall-recover] RECALL_RECOVER_SECRET not set — rejecting request');
    return false;
  }
  return authHeader === `Bearer ${secret}`;
}

// ─── POST /recall/recover/:botId ──────────────────────────────────────────────

export const recallRecoverRoute: ApiRoute = {
  path: '/recall/recover/:botId',
  method: 'POST',
  requiresAuth: false, // guarded by RECALL_RECOVER_SECRET instead
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: any) => {
    if (!authorizeRequest(c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const botId = c.req.param('botId') as string;
    console.log(`[recall-recover] Recovering bot: ${botId}`);

    // 1. Fetch bot details to confirm it is done
    const botRes = await recallFetch(`${RECALL_BASE}/bot/${botId}/`, {
      headers: recallHeaders(),
    });
    if (!botRes.ok) {
      return c.json({ error: `Bot not found: ${await botRes.text()}` }, 404);
    }

    const bot = (await botRes.json()) as {
      id: string;
      status_changes: { code: string; created_at: string }[];
      metadata?: Record<string, string>;
    };

    const isDone = bot.status_changes.some(s => ['done', 'call_ended'].includes(s.code));
    if (!isDone) {
      return c.json({ error: 'Bot is not done yet — cannot recover a live session' }, 409);
    }

    // 2. List recordings for this bot
    const recRes = await recallFetch(`${RECALL_BASE}/recording/?bot_id=${botId}`, {
      headers: recallHeaders(),
    });
    if (!recRes.ok) {
      return c.json({ error: `Failed to list recordings: ${await recRes.text()}` }, 500);
    }

    const recData = (await recRes.json()) as { results: { id: string }[] };
    const recordings = recData.results;

    if (recordings.length === 0) {
      return c.json({ error: 'No recordings found for this bot' }, 404);
    }

    // 3. Kick off transcription for each recording
    const jobs: { recordingId: string; transcriptId?: string; error?: string }[] = [];

    for (const recording of recordings) {
      const txRes = await recallFetch(`${RECALL_BASE}/recording/${recording.id}/create_transcript/`, {
        method: 'POST',
        headers: recallHeaders(),
        body: JSON.stringify({
          provider: { recallai_async: { language_code: 'en' } },
          diarization: { use_separate_streams_when_available: true },
        }),
      });

      if (!txRes.ok) {
        const errText = await txRes.text();
        console.error(`[recall-recover] create_transcript failed for ${recording.id}: ${errText}`);
        jobs.push({ recordingId: recording.id, error: errText });
      } else {
        const txData = (await txRes.json()) as { id: string };
        console.log(`[recall-recover] Transcript job ${txData.id} started for recording ${recording.id}`);
        jobs.push({ recordingId: recording.id, transcriptId: txData.id });
      }
    }

    return c.json({
      botId,
      message: 'Transcription job(s) started. processMeetingWorkflow will run when transcript.done fires.',
      jobs,
    });
  }),
};

// ─── POST /recall/reprocess/:botId ───────────────────────────────────────────
// Use when the transcript IS already done but processMeetingWorkflow didn't run.

export const recallReprocessRoute: ApiRoute = {
  path: '/recall/reprocess/:botId',
  method: 'POST',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: ({ mastra }): any => Promise.resolve(async (c: any) => {
    if (!authorizeRequest(c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const botId = c.req.param('botId') as string;
    const body = (await c.req.json().catch(() => ({}))) as { transcriptId?: string };

    console.log(`[recall-reprocess] Reprocessing bot: ${botId}`);

    let transcriptId = body.transcriptId;

    // If transcriptId not provided, look it up from the bot's recordings
    if (!transcriptId) {
      const recRes = await recallFetch(`${RECALL_BASE}/recording/?bot_id=${botId}`, {
        headers: recallHeaders(),
      });
      if (!recRes.ok) {
        return c.json({ error: `Failed to list recordings: ${await recRes.text()}` }, 500);
      }

      const recData = (await recRes.json()) as { results: { id: string }[] };
      if (recData.results.length === 0) {
        return c.json({ error: 'No recordings found for this bot' }, 404);
      }

      // Find the first recording that has a completed transcript
      for (const recording of recData.results) {
        const txListRes = await recallFetch(`${RECALL_BASE}/transcript/?recording_id=${recording.id}`, {
          headers: recallHeaders(),
        });
        if (!txListRes.ok) continue;

        const txList = (await txListRes.json()) as { results: { id: string; status: string }[] };
        const done = txList.results.find(t => t.status === 'done');
        if (done) {
          transcriptId = done.id;
          break;
        }
      }

      if (!transcriptId) {
        return c.json({
          error: 'No completed transcript found. Use /recall/recover/:botId to start transcription first.',
        }, 404);
      }
    }

    // Trigger processMeetingWorkflow directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = mastra as unknown as {
      getWorkflow: (id: string) => {
        createRun: () => Promise<{ startAsync: (opts: { inputData: unknown }) => Promise<unknown> }>;
      } | undefined;
    };

    const workflow = m.getWorkflow('processMeetingWorkflow');
    if (!workflow) {
      return c.json({ error: 'processMeetingWorkflow not found in Mastra instance' }, 500);
    }

    const run = await workflow.createRun();
    void run.startAsync({
      inputData: { transcriptId, botId },
    }).catch(err => {
      console.error('[recall-reprocess] processMeetingWorkflow error:', err);
    });

    console.log(`[recall-reprocess] processMeetingWorkflow triggered — transcript ${transcriptId}`);
    return c.json({ botId, transcriptId, message: 'processMeetingWorkflow triggered' });
  }),
};
