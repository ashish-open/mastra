/**
 * Meetings persistence layer — LibSQL (SQLite-compatible).
 *
 * Backed by MEETINGS_DB_URL env var (default: file:./meetings.db).
 * Follows the same lazy-singleton + ensureSchema() pattern as reco/db.ts.
 *
 * Two tables:
 *
 *   meetings(bot_id PK, transcript_id, title, type, duration_min,
 *            speaker_count, word_count, plain_text, created_at,
 *            processed_at, summary_md, action_items JSON, decisions JSON,
 *            key_topics JSON, slack_channel, slack_posted)
 *
 *   meeting_action_items(id PK, bot_id FK, task, owner, deadline, status,
 *                        confidence, created_at)
 *     — normalised rows for querying by owner / deadline
 *
 * Why a separate meetings.db (not mastra.db)?
 *   Mastra owns mastra.db — sharing it risks migration collisions on framework
 *   upgrades. We own meetings.db and can migrate it on our schedule.
 *
 * Lifecycle:
 *   1. migrateMeetingsDb() called at startup in index.ts (idempotent CREATE IF NOT EXISTS)
 *   2. upsertMeetingRaw() called in Step 2 of processMeetingWorkflow
 *   3. saveMeetingFinal() called in Step 4 after summary + Slack post
 *   4. getMeeting() / listMeetings() called by Q&A route + integration endpoints
 */

import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'crypto';
import type {
  Meeting,
  MeetingListItem,
  RawMeetingInput,
  FinalMeetingInput,
  ActionItem,
  Decision,
} from './types.js';

const DB_URL = process.env.MEETINGS_DB_URL ?? 'file:./meetings.db';

// ─── Lazy singleton ───────────────────────────────────────────────────────────

let _client: Client | null = null;
let _schemaReady: Promise<void> | null = null;

function getClient(): Client {
  if (!_client) {
    _client = createClient({ url: DB_URL });
    console.log(`[meetings-db] Connected to ${DB_URL}`);
  }
  return _client;
}

// ─── Schema migration (idempotent) ───────────────────────────────────────────

async function ensureSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const c = getClient();
    await c.executeMultiple(`
      CREATE TABLE IF NOT EXISTS meetings (
        bot_id         TEXT PRIMARY KEY,
        transcript_id  TEXT NOT NULL,
        title          TEXT NOT NULL,
        type           TEXT NOT NULL DEFAULT 'general',
        duration_min   INTEGER,
        speaker_count  INTEGER NOT NULL DEFAULT 0,
        word_count     INTEGER NOT NULL DEFAULT 0,
        plain_text     TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        processed_at   TEXT,
        summary_md     TEXT,
        action_items   TEXT,   -- JSON array of ActionItem
        decisions      TEXT,   -- JSON array of Decision
        key_topics     TEXT,   -- JSON array of string
        slack_channel  TEXT,
        slack_posted   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_meetings_type      ON meetings(type);
      CREATE INDEX IF NOT EXISTS idx_meetings_created   ON meetings(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meetings_processed ON meetings(processed_at DESC);

      CREATE TABLE IF NOT EXISTS meeting_action_items (
        id          TEXT PRIMARY KEY,
        bot_id      TEXT NOT NULL REFERENCES meetings(bot_id) ON DELETE CASCADE,
        task        TEXT NOT NULL,
        owner       TEXT NOT NULL,
        deadline    TEXT,              -- 'YYYY-MM-DD' or NULL
        status      TEXT NOT NULL DEFAULT 'open',
        confidence  TEXT NOT NULL DEFAULT 'medium',
        created_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mai_bot_id ON meeting_action_items(bot_id);
      CREATE INDEX IF NOT EXISTS idx_mai_owner  ON meeting_action_items(owner);
      CREATE INDEX IF NOT EXISTS idx_mai_status ON meeting_action_items(status);

      -- Webhook delivery log for idempotency.
      -- Recall retries failed webhook deliveries; this table lets us detect and
      -- short-circuit duplicate processing. webhook_id is the Svix msg id from
      -- the "webhook-id" header — globally unique per delivery attempt.
      CREATE TABLE IF NOT EXISTS recall_webhook_log (
        webhook_id   TEXT PRIMARY KEY,
        event        TEXT NOT NULL,
        bot_id       TEXT,
        received_at  TEXT NOT NULL,
        outcome      TEXT NOT NULL DEFAULT 'processed',  -- processed | duplicate | error
        error_msg    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_rwl_bot_id ON recall_webhook_log(bot_id);
      CREATE INDEX IF NOT EXISTS idx_rwl_event  ON recall_webhook_log(event);

      -- Recording / transcript failures (for visibility and retry tracking).
      CREATE TABLE IF NOT EXISTS meeting_failures (
        id            TEXT PRIMARY KEY,
        bot_id        TEXT NOT NULL,
        event         TEXT NOT NULL,
        code          TEXT,
        sub_code      TEXT,
        recording_id  TEXT,
        transcript_id TEXT,
        retried_with  TEXT,
        retry_status  TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mf_bot_id ON meeting_failures(bot_id);
      CREATE INDEX IF NOT EXISTS idx_mf_event  ON meeting_failures(event);
    `);
    console.log('[meetings-db] schema ready');
  })();
  return _schemaReady;
}

// ─── Public: startup migration ────────────────────────────────────────────────

/**
 * Call once at app startup (index.ts). Idempotent — safe to call on every restart.
 */
export async function migrateMeetingsDb(): Promise<void> {
  await ensureSchema();
}

// ─── Public: write operations ─────────────────────────────────────────────────

/**
 * Insert or replace the raw meeting record immediately after the transcript is
 * downloaded (Step 2 of processMeetingWorkflow). Stores the full plain_text so
 * Q&A can answer questions without re-fetching from Recall.ai.
 *
 * Uses INSERT OR REPLACE so reprocessing the same botId is idempotent.
 */
export async function upsertMeetingRaw(input: RawMeetingInput): Promise<void> {
  await ensureSchema();
  const c = getClient();
  await c.execute({
    sql: `
      INSERT OR REPLACE INTO meetings
        (bot_id, transcript_id, title, type, duration_min, speaker_count,
         word_count, plain_text, created_at)
      VALUES
        (:botId, :transcriptId, :title, :type, :durationMin, :speakerCount,
         :wordCount, :plainText, :createdAt)
    `,
    args: {
      botId: input.botId,
      transcriptId: input.transcriptId,
      title: input.title,
      type: input.type,
      durationMin: input.durationMin ?? null,
      speakerCount: input.speakerCount,
      wordCount: input.wordCount,
      plainText: input.plainText,
      createdAt: input.createdAt,
    },
  });
}

/**
 * Update the meeting record with the final LLM outputs (Step 4).
 * Also writes normalised action items to meeting_action_items for querying.
 */
export async function saveMeetingFinal(
  botId: string,
  input: FinalMeetingInput,
): Promise<void> {
  await ensureSchema();
  const c = getClient();
  const now = new Date().toISOString();

  // Update the meetings row
  await c.execute({
    sql: `
      UPDATE meetings SET
        processed_at  = :processedAt,
        summary_md    = :summaryMd,
        action_items  = :actionItems,
        decisions     = :decisions,
        key_topics    = :keyTopics,
        slack_channel = :slackChannel,
        slack_posted  = :slackPosted
      WHERE bot_id = :botId
    `,
    args: {
      botId,
      processedAt: now,
      summaryMd: input.summaryMd,
      actionItems: JSON.stringify(input.actionItems),
      decisions: JSON.stringify(input.decisions),
      keyTopics: JSON.stringify(input.keyTopics),
      slackChannel: input.slackChannel,
      slackPosted: input.slackPosted ? 1 : 0,
    },
  });

  // Delete existing action items for this bot (idempotent reprocess)
  await c.execute({ sql: 'DELETE FROM meeting_action_items WHERE bot_id = ?', args: [botId] });

  // Insert fresh action items
  if (input.actionItems.length > 0) {
    for (const item of input.actionItems) {
      await c.execute({
        sql: `
          INSERT INTO meeting_action_items (id, bot_id, task, owner, deadline, confidence, created_at)
          VALUES (:id, :botId, :task, :owner, :deadline, :confidence, :createdAt)
        `,
        args: {
          id: randomUUID(),
          botId,
          task: item.task,
          owner: item.owner,
          deadline: item.deadline ?? null,
          confidence: item.confidence,
          createdAt: now,
        },
      });
    }
  }
}

/**
 * Persist the structured analysis output (Step 3) separately from the final
 * summary (Step 4). This keeps the two concerns independent:
 *   - saveStructuredAnalysis: action items, decisions, key topics (LLM extraction)
 *   - saveMeetingFinal: summary_md, slack_channel, slack_posted (formatting + post)
 *
 * Writing action items here (before Slack posting) means the Q&A endpoint and
 * the OpenArc meetings list already have structured data even if the Slack step
 * fails or is skipped.
 */
export async function saveStructuredAnalysis(
  botId: string,
  input: {
    actionItems: ActionItem[];
    decisions: Decision[];
    keyTopics: string[];
  },
): Promise<void> {
  await ensureSchema();
  const c = getClient();
  const now = new Date().toISOString();

  await c.execute({
    sql: `
      UPDATE meetings SET
        action_items = :actionItems,
        decisions    = :decisions,
        key_topics   = :keyTopics
      WHERE bot_id = :botId
    `,
    args: {
      botId,
      actionItems: JSON.stringify(input.actionItems),
      decisions: JSON.stringify(input.decisions),
      keyTopics: JSON.stringify(input.keyTopics),
    },
  });

  // Replace normalised action item rows
  await c.execute({ sql: 'DELETE FROM meeting_action_items WHERE bot_id = ?', args: [botId] });
  for (const item of input.actionItems) {
    await c.execute({
      sql: `
        INSERT INTO meeting_action_items (id, bot_id, task, owner, deadline, confidence, created_at)
        VALUES (:id, :botId, :task, :owner, :deadline, :confidence, :createdAt)
      `,
      args: {
        id: randomUUID(),
        botId,
        task: item.task,
        owner: item.owner,
        deadline: item.deadline ?? null,
        confidence: item.confidence,
        createdAt: now,
      },
    });
  }
}

// ─── Public: read operations ──────────────────────────────────────────────────

/**
 * Fetch a single meeting with its full transcript and parsed JSON fields.
 * Returns null if not found.
 */
export async function getMeeting(botId: string): Promise<Meeting | null> {
  await ensureSchema();
  const c = getClient();
  const result = await c.execute({
    sql: 'SELECT * FROM meetings WHERE bot_id = ?',
    args: [botId],
  });

  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  // Fetch normalised action items
  const aiResult = await c.execute({
    sql: 'SELECT task, owner, deadline, confidence FROM meeting_action_items WHERE bot_id = ? ORDER BY rowid',
    args: [botId],
  });

  return rowToMeeting(row, aiResult.rows);
}

/**
 * List meetings for the integration endpoint. Does NOT include plain_text
 * (too large — that's for the detail view only).
 */
export async function listMeetings(opts: {
  limit?: number;
  offset?: number;
  type?: string;
}): Promise<MeetingListItem[]> {
  await ensureSchema();
  const c = getClient();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const whereClause = opts.type ? 'WHERE type = ?' : '';
  const args: (string | number)[] = opts.type
    ? [opts.type, limit, offset]
    : [limit, offset];

  const result = await c.execute({
    sql: `
      SELECT bot_id, title, type, duration_min, speaker_count, created_at,
             slack_channel, slack_posted
      FROM meetings
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
    args,
  });

  return result.rows.map(row => ({
    botId: String(row['bot_id'] ?? ''),
    title: String(row['title'] ?? ''),
    type: String(row['type'] ?? 'general'),
    durationMin: row['duration_min'] != null ? Number(row['duration_min']) : null,
    speakerCount: Number(row['speaker_count'] ?? 0),
    createdAt: String(row['created_at'] ?? ''),
    slackChannel: row['slack_channel'] ? String(row['slack_channel']) : null,
    slackPosted: Number(row['slack_posted'] ?? 0) === 1,
  }));
}

// ─── Webhook idempotency log ──────────────────────────────────────────────────

/**
 * Record that a webhook with this Svix webhook-id has been seen. Returns true
 * if this is the FIRST time we've seen this id (caller should process it),
 * false if it's a duplicate delivery (caller should skip).
 *
 * Uses INSERT OR IGNORE — the row only gets created the first time. SQLite
 * tells us via `rowsAffected` whether we won the race.
 */
export async function recordWebhookDelivery(
  webhookId: string,
  event: string,
  botId: string | null,
): Promise<{ isNew: boolean }> {
  await ensureSchema();
  const c = getClient();
  const result = await c.execute({
    sql: `
      INSERT OR IGNORE INTO recall_webhook_log
        (webhook_id, event, bot_id, received_at)
      VALUES (:webhookId, :event, :botId, :receivedAt)
    `,
    args: {
      webhookId,
      event,
      botId: botId ?? null,
      receivedAt: new Date().toISOString(),
    },
  });
  return { isNew: (result.rowsAffected ?? 0) > 0 };
}

/** Update outcome after processing — for observability only, not used in the dedup gate. */
export async function markWebhookOutcome(
  webhookId: string,
  outcome: 'processed' | 'error',
  errorMsg?: string,
): Promise<void> {
  await ensureSchema();
  const c = getClient();
  await c.execute({
    sql: 'UPDATE recall_webhook_log SET outcome = ?, error_msg = ? WHERE webhook_id = ?',
    args: [outcome, errorMsg ?? null, webhookId],
  });
}

// ─── Meeting failure log ──────────────────────────────────────────────────────

/**
 * Record a recording.failed / transcript.failed / bot.recording_permission_denied
 * event so it's visible in the OpenArc dashboard and auditable later.
 */
export async function recordMeetingFailure(input: {
  botId: string;
  event: string;
  code?: string | null;
  subCode?: string | null;
  recordingId?: string | null;
  transcriptId?: string | null;
  retriedWith?: string | null;
}): Promise<void> {
  await ensureSchema();
  const c = getClient();
  await c.execute({
    sql: `
      INSERT INTO meeting_failures
        (id, bot_id, event, code, sub_code, recording_id, transcript_id,
         retried_with, retry_status, created_at)
      VALUES
        (:id, :botId, :event, :code, :subCode, :recordingId, :transcriptId,
         :retriedWith, :retryStatus, :createdAt)
    `,
    args: {
      id: randomUUID(),
      botId: input.botId,
      event: input.event,
      code: input.code ?? null,
      subCode: input.subCode ?? null,
      recordingId: input.recordingId ?? null,
      transcriptId: input.transcriptId ?? null,
      retriedWith: input.retriedWith ?? null,
      retryStatus: input.retriedWith ? 'pending' : 'not_retried',
      createdAt: new Date().toISOString(),
    },
  });
}

// ─── Private: row → Meeting mapper ────────────────────────────────────────────

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function rowToMeeting(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actionItemRows: Record<string, any>[],
): Meeting {
  return {
    botId: String(row['bot_id'] ?? ''),
    transcriptId: String(row['transcript_id'] ?? ''),
    title: String(row['title'] ?? ''),
    type: String(row['type'] ?? 'general'),
    durationMin: row['duration_min'] != null ? Number(row['duration_min']) : null,
    speakerCount: Number(row['speaker_count'] ?? 0),
    wordCount: Number(row['word_count'] ?? 0),
    plainText: String(row['plain_text'] ?? ''),
    createdAt: String(row['created_at'] ?? ''),
    processedAt: row['processed_at'] ? String(row['processed_at']) : null,
    summaryMd: row['summary_md'] ? String(row['summary_md']) : null,
    actionItems: actionItemRows.length > 0
      ? actionItemRows.map(r => ({
          task: String(r['task'] ?? ''),
          owner: String(r['owner'] ?? 'TBD'),
          deadline: r['deadline'] ? String(r['deadline']) : null,
          confidence: (r['confidence'] ?? 'medium') as ActionItem['confidence'],
        }))
      : safeParseJson<ActionItem[] | null>(row['action_items'], null),
    decisions: safeParseJson<Decision[] | null>(row['decisions'], null),
    keyTopics: safeParseJson<string[] | null>(row['key_topics'], null),
    slackChannel: row['slack_channel'] ? String(row['slack_channel']) : null,
    slackPosted: Number(row['slack_posted'] ?? 0) === 1,
  };
}
