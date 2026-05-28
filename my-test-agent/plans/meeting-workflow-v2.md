# Blueprint: Meeting Workflow v2 — Per-Team Intelligence + Q&A

**Objective**: Transform `processMeetingWorkflow` from a single-pass summariser into a
full meeting-intelligence pipeline that (1) produces team-specific structured outputs,
(2) persists every meeting so teams can query it later, and (3) exposes a Q&A endpoint
so anyone can ask questions about any past meeting.

**Current state (as of 2026-05-22)**
- `processMeetingWorkflow`: 2 steps — download transcript → generate summary + post Slack
- Good type-specific formats exist in `meeting-agent.ts` instructions
- Summary is generated as raw Markdown; action items are text-only (no structured extraction)
- No persistence — once a meeting is processed it cannot be queried
- Q&A endpoint `/recall/ask/:botId` is referenced in the Slack footer but not implemented
- Slack posting is skipped when channel webhooks are not configured (no error surfaced)
- 1-speaker issue: diarization with `recallai_async` provider sometimes doesn't separate speakers

**Target state**
- 5-step workflow: download → persist raw → structured analysis → format + post → persist final
- Every meeting stored in `meetings.db` (LibSQL) with full transcript + structured outputs
- Q&A endpoint: `POST /recall/ask/:botId` returns LLM answers grounded in stored transcript
- OpenArc dashboard: meetings list + detail page with live Q&A panel
- Slack posts include richer blocks (action item table, thread prompt for Q&A)

---

## Step 1 — Meeting persistence DB schema + migrate

**Context brief**: New LibSQL file `meetings.db`. Two tables: `meetings` (one row per bot run)
and `meeting_action_items` (normalised rows, queryable by assignee/deadline).
This is the foundation all later steps build on.

**Files to create/modify**:
- `src/mastra/meetings/db.ts` — schema, migrate(), helpers (upsertMeeting, getMeeting, saveFinal)
- `src/mastra/meetings/types.ts` — shared TypeScript types
- `.env` — add `MEETINGS_DB_URL=file:./meetings.db`

**Schema**:
```sql
CREATE TABLE IF NOT EXISTS meetings (
  bot_id         TEXT PRIMARY KEY,
  transcript_id  TEXT NOT NULL,
  title          TEXT NOT NULL,
  type           TEXT NOT NULL,
  duration_min   INTEGER,
  speaker_count  INTEGER,
  word_count     INTEGER,
  plain_text     TEXT NOT NULL,          -- full transcript, stored for Q&A
  created_at     TEXT NOT NULL,
  processed_at   TEXT,
  summary_md     TEXT,                   -- final formatted Markdown (set in step 5)
  action_items   TEXT,                   -- JSON array (set in step 4)
  decisions      TEXT,                   -- JSON array (set in step 4)
  slack_channel  TEXT,
  slack_posted   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meeting_action_items (
  id          TEXT PRIMARY KEY,          -- uuid
  bot_id      TEXT NOT NULL REFERENCES meetings(bot_id),
  task        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  deadline    TEXT,                      -- 'YYYY-MM-DD' or NULL
  status      TEXT DEFAULT 'open',       -- open | done
  created_at  TEXT NOT NULL
);
```

**Task list**:
1. Create `src/mastra/meetings/types.ts` with `Meeting`, `ActionItem`, `Decision` interfaces
2. Create `src/mastra/meetings/db.ts`:
   - `openMeetingsDb()` — returns LibSQL client for `meetings.db`
   - `migrateMeetingsDb()` — CREATE TABLE IF NOT EXISTS (idempotent)
   - `upsertMeetingRaw(data)` — insert/replace on bot_id conflict
   - `saveMeetingFinal(botId, { summaryMd, actionItems, decisions, slackChannel, slackPosted })` — UPDATE
   - `getMeeting(botId)` — SELECT with JOIN for action_items
   - `listMeetings(limit, offset, type?)` — for OpenArc list endpoint
3. Add `MEETINGS_DB_URL=file:./meetings.db` to `.env`
4. Call `migrateMeetingsDb()` at startup in `src/mastra/index.ts` (alongside reco config init)

**Verification**:
```bash
npx tsc --noEmit -p .
node -e "import('./src/mastra/meetings/db.ts').then(m => m.migrateMeetingsDb()).then(() => console.log('OK'))"
```

**Exit criteria**: `meetings.db` is created with both tables on first run; idempotent on restart.

---

## Step 2 — Refactor workflow: download → persist raw

**Context brief**: Split the current `downloadTranscriptStep` to add a `persistRawMeetingStep`
immediately after. The transcript is stored in `meetings.db` before any LLM work begins.
If the LLM step fails, the data is safe and reprocessing is possible.

**Files to modify**:
- `src/mastra/workflows/meeting-workflow.ts` — add `persistRawMeetingStep`, thread it in

**New step** (insert between `downloadTranscriptStep` and `generateAndPostSummaryStep`):
```typescript
const persistRawMeetingStep = createStep({
  id: 'persist-raw-meeting',
  inputSchema: /* same as downloadTranscriptStep outputSchema */,
  outputSchema: /* pass-through + persisted: true */,
  execute: async ({ inputData }) => {
    await upsertMeetingRaw({
      botId: inputData.botId,
      transcriptId: inputData.transcriptId,
      title: inputData.meetingTitle,
      type: inputData.meetingType,
      durationMin: inputData.durationMinutes,
      speakerCount: inputData.speakerCount,
      wordCount: inputData.wordCount,
      plainText: inputData.plainText,
      createdAt: new Date().toISOString(),
    });
    console.log(`[meeting-workflow] Raw meeting persisted for bot ${inputData.botId}`);
    return { ...inputData, persisted: true };
  },
});
```

**Workflow chain** becomes:
```
downloadTranscriptStep → persistRawMeetingStep → generateAndPostSummaryStep
```

**Task list**:
1. Add `persistRawMeetingStep` in `meeting-workflow.ts`
2. Import `upsertMeetingRaw` from `../meetings/db.js`
3. Update workflow `.then()` chain
4. Typecheck

**Exit criteria**: After running the workflow, `sqlite3 meetings.db "SELECT bot_id, title FROM meetings"` shows the row.

---

## Step 3 — Structured analysis step (LLM with JSON output)

**Context brief**: Add a new `extractStructuredStep` between `persistRawMeetingStep` and the
summary step. This step uses the meeting agent with **structured output** (Zod schema) to
extract action items, decisions, and key topics as JSON — not as part of the Markdown narrative.
Separating extraction from formatting means: (a) action items are queryable, (b) the summary
prompt doesn't have to do two jobs at once, (c) we can build action-item dashboards later.

**Why structured output here, not in the agent instructions?**
The current approach asks the agent to produce formatted Markdown that *includes* action items.
This causes "TBD" owner defaults because the LLM is trying to format and extract simultaneously.
A dedicated extraction call with a strict JSON schema forces the model to focus only on "who
said they'd do what."

**Files to create/modify**:
- `src/mastra/workflows/meeting-workflow.ts` — add `extractStructuredStep`
- `src/mastra/agents/meeting-agent.ts` — add an `extractStructuredOutput` helper call
  (or inline in the step using `agent.generate` with `output` schema)

**Structured output schema**:
```typescript
const structuredOutputSchema = z.object({
  actionItems: z.array(z.object({
    task: z.string(),
    owner: z.string(),          // real speaker name or "TBD"
    deadline: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
  })),
  decisions: z.array(z.object({
    decision: z.string(),
    madeBy: z.string().nullable(),
  })),
  keyTopics: z.array(z.string()),
  openQuestions: z.array(z.string()),
  sentimentSignals: z.object({   // for sales/support meetings
    positiveSignals: z.array(z.string()),
    concerns: z.array(z.string()),
  }).optional(),
});
```

**Extraction prompt** (short, focused, no formatting instructions):
```
Extract ONLY from the transcript below. Return JSON only — no markdown.
Speakers: ${speakers.join(', ')}

Find:
1. Action items: explicit commitments ("I'll...", "let me...", "we'll fix").
   Owner must be a speaker name above. Use "TBD" ONLY if truly unattributed.
2. Decisions: things that were finalised/agreed (not discussed, agreed).
3. Key topics: 3-7 words each, max 10.
4. Open questions: things raised but not resolved.
${meetingType === 'sales' || meetingType === 'support' ? '5. Sentiment signals: positive and negative.' : ''}

TRANSCRIPT:
${plainText.slice(0, 16000)}
```

**Task list**:
1. Define `structuredOutputSchema` in `meeting-workflow.ts`
2. Add `extractStructuredStep`:
   - Calls `agent.generate(messages, { output: structuredOutputSchema })`
   - Returns `actionItems`, `decisions`, `keyTopics`, `openQuestions`, `sentimentSignals`
3. Save action items to `meeting_action_items` table (call `saveActionItems(botId, items)`)
4. Update `persistRawMeetingStep` output schema to pass-through; insert `extractStructuredStep` after it
5. Thread the structured output into the next step's inputSchema
6. Typecheck

**Verification**:
```bash
# After running a meeting workflow, inspect extracted items
sqlite3 meetings.db "SELECT task, owner, deadline FROM meeting_action_items LIMIT 10"
```

**Exit criteria**: Action items in DB have real owner names, not "TBD" for attributed items.

---

## Step 4 — Improved summary + Slack post

**Context brief**: Refactor `generateAndPostSummaryStep` to receive the structured output from
Step 3 (action items, decisions, topics) and use it to anchor the formatted summary. The agent
no longer needs to re-extract — it formats what was already extracted. This eliminates fabricated
action items and reduces prompt complexity.

Additionally: fix the Slack skip-silently issue by logging a warning when `slackSkipped: true`,
and add Slack channel configuration validation at startup.

**Files to modify**:
- `src/mastra/workflows/meeting-workflow.ts` — update `generateAndPostSummaryStep` input/prompt
- `src/mastra/agents/meeting-agent.ts` — streamline system prompt (extraction section removed)
- `src/mastra/tools/slack-tool.ts` — improve skip logging

**Prompt change (key)**: Pass pre-extracted structured data into the prompt:
```
PRE-EXTRACTED (from transcript — use these, don't re-extract):
Action items: ${JSON.stringify(actionItems, null, 2)}
Decisions: ${JSON.stringify(decisions)}
Key topics: ${keyTopics.join(', ')}
Open questions: ${openQuestions.join('\n')}

Your job: Write the ${meetingType.toUpperCase()} format summary using the above.
Do NOT re-extract. Focus only on writing clear, readable Markdown for Slack.
```

**Slack post improvement**: Structure the post as Slack blocks:
- Header block: meeting title + emoji + type + duration
- Section: formatted summary body
- Divider
- Action items table (if any)
- Footer: `💬 Ask about this meeting → POST /recall/ask/{botId}`

**Task list**:
1. Update `generateAndPostSummaryStep` inputSchema to include structured output fields
2. Inject pre-extracted data into agent prompt
3. Update `postSlackMessage` to accept optional `actionItems` for a dedicated block
4. Add startup warning if Slack webhook URLs are blank (`SLACK_WEBHOOK_URL` etc.)
5. Update `saveMeetingFinal()` call to persist `summaryMd` after Slack post
6. Typecheck

**Exit criteria**: Slack post contains real owner names in action items; `summary_md` column in meetings.db is populated.

---

## Step 5 — Q&A endpoint: POST /recall/ask/:botId

**Context brief**: Implement the `/recall/ask/:botId` endpoint that is already referenced in
every Slack post footer. Takes a question, loads the meeting's plain text from `meetings.db`,
and runs the meeting agent in Q&A mode. The agent's instructions already have detailed Q&A
guidance (see `meeting-agent.ts` lines 243–264) — the route just needs to wire it up correctly.

**Why DB, not Recall.ai API?** Recall.ai transcript URLs are time-limited signed S3 URLs. By
storing `plain_text` in `meetings.db` at processing time (Step 2), Q&A works indefinitely
without re-fetching from Recall.

**Files to create**:
- `src/mastra/routes/recall-ask.ts` — new route

**Route contract**:
```
POST /recall/ask/:botId
Authorization: Bearer <MASTRA_INTEGRATION_TOKEN>
Body: { "question": "What did the client say about pricing?" }
Response: { "botId": "...", "question": "...", "answer": "..." }
```

**Implementation**:
```typescript
// 1. Load meeting from DB (getMeeting(botId))
// 2. If not found → 404
// 3. Build Q&A prompt with meeting metadata + full transcript
// 4. Call meetingAgent.generate() with memory scoped to meeting-{botId}
// 5. Return answer as JSON
```

**Q&A prompt**:
```
Meeting: "${meeting.title}" (${meeting.type}, ${meeting.durationMin} min)
Date: ${meeting.createdAt}
Speakers: (derived from plain_text)

TRANSCRIPT (full):
${meeting.plainText}

---
QUESTION: ${question}

Answer based ONLY on the transcript above. If the answer is not in the transcript,
say so — do not guess. Quote the relevant part of the transcript in your answer.
```

**Task list**:
1. Create `src/mastra/routes/recall-ask.ts`
2. Import `getMeeting` from `../meetings/db.js`
3. Auth check: require `MASTRA_INTEGRATION_TOKEN` (same pattern as integration routes)
4. 404 if meeting not in DB ("Meeting not found. It may not have been processed yet.")
5. Call `meetingAgent.generate()` with structured Q&A prompt
6. Register route in `src/mastra/index.ts`
7. Typecheck

**Verification**:
```bash
TOKEN=$(grep MASTRA_INTEGRATION_TOKEN .env | cut -d= -f2)
curl -X POST http://localhost:4111/recall/ask/<botId> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question": "What were the main action items?"}'
```

**Exit criteria**: Returns a grounded answer with transcript quotes, not fabricated content.

---

## Step 6 — OpenArc integration endpoints + dashboard meetings page

**Context brief**: Expose meetings data to OpenArc dashboard via `/integration/meetings` endpoints.
OpenArc already calls `/integration/reco/runs` — same pattern. The dashboard gets a meetings list
and per-meeting detail + Q&A (which proxies to `/recall/ask/:botId`).

**Files to modify**:
- `src/mastra/routes/integration.ts` — add `integrationMeetingsRoute`, `integrationMeetingDetailRoute`
- `INTEGRATION.md` — document new endpoints
- OpenArc: new `Meetings` page in dashboard (separate session — OpenArc repo)

**New endpoints**:
```
GET  /integration/meetings?limit=20&offset=0&type=sales
     → { meetings: [{ botId, title, type, duration, createdAt, speakerCount, slackPosted }] }

GET  /integration/meetings/:botId
     → { meeting: Meeting, actionItems: ActionItem[] }

POST /integration/meetings/:botId/ask
     → proxy to /recall/ask/:botId (same auth token)
```

**Task list**:
1. Add `listMeetings()` and `getMeeting()` queries to `meetings/db.ts`
2. Add three routes to `integration.ts`
3. Register in `index.ts` apiRoutes
4. Update `INTEGRATION.md`
5. Typecheck + smoke test with curl
6. (Separate session) Build OpenArc Meetings page: list view + detail with Q&A panel

**Exit criteria**:
```bash
curl http://localhost:4111/integration/meetings \
  -H "Authorization: Bearer $TOKEN" | jq '.meetings[0].title'
```

---

## Step 7 — Fix Slack channel webhooks + improve skip handling

**Context brief**: The `slackSkipped: true` in the current output means no webhook URLs are
configured. This is a silent failure — the Slack post never happens, teams don't know, and
there's no retry. Fix: validate at startup, log clearly, and surface in workflow output.

**Files to modify**:
- `src/mastra/tools/slack-tool.ts` — improve skip/error handling, per-channel fallback
- `src/mastra/index.ts` — startup validation

**.env** — configure:
```
SLACK_WEBHOOK_SALES=https://hooks.slack.com/services/...
SLACK_WEBHOOK_ONBOARDING=https://hooks.slack.com/services/...
SLACK_WEBHOOK_OPS=https://hooks.slack.com/services/...
SLACK_WEBHOOK_SUPPORT=https://hooks.slack.com/services/...
SLACK_WEBHOOK_FINANCE=https://hooks.slack.com/services/...
SLACK_WEBHOOK_PRODUCT=https://hooks.slack.com/services/...
SLACK_WEBHOOK_ENGINEERING=https://hooks.slack.com/services/...
SLACK_WEBHOOK_HR=https://hooks.slack.com/services/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...  # fallback for 'general'
```

**Startup validation** (warn, don't crash):
```typescript
const missingSlackChannels = Object.entries(CHANNEL_MAP)
  .filter(([, ch]) => !process.env[`SLACK_WEBHOOK_${ch.toUpperCase()}`] && !process.env.SLACK_WEBHOOK_URL)
  .map(([type]) => type);
if (missingSlackChannels.length > 0) {
  console.warn(`[meeting] Slack webhooks not configured for: ${missingSlackChannels.join(', ')}. Meeting summaries will be stored but not posted.`);
}
```

**Task list**:
1. Set up Slack incoming webhooks for each channel (manual step in Slack workspace)
2. Add channel-specific env var lookup to `postSlackMessage` with fallback to `SLACK_WEBHOOK_URL`
3. Add startup validation warning
4. Improve `slackSkipped` log to mention which channel was missing

**Exit criteria**: Running workflow with webhooks configured results in `slackPosted: true`.

---

## Parallelism & ordering

```
Step 1 (DB schema)
  └─ Step 2 (persist raw step in workflow)
       └─ Step 3 (structured analysis step)
            └─ Step 4 (summary + Slack)
                 ├─ Step 5 (Q&A route) ← independent, can start after Step 1
                 ├─ Step 6 (integration endpoints) ← independent after Step 1
                 └─ Step 7 (Slack fix) ← independent, can do anytime
```

**Recommended execution order**: Steps 1 → 2 → 3 → 4 (workflow chain, sequential).
Steps 5, 6, 7 can be done in any order after Step 1.

**Estimated session split**:
- Session A: Steps 1 + 2 + 3 (DB + workflow restructure)
- Session B: Steps 4 + 5 (summary improvements + Q&A route)
- Session C: Steps 6 + 7 (OpenArc page + Slack config)

---

## Invariants (must hold after every step)

- `npx tsc --noEmit -p .` passes
- `processMeetingWorkflow` still triggers correctly from `transcript.done` webhook
- `deployMeetingBotWorkflow` is unchanged
- No existing routes broken (recovery routes, reco routes, integration routes)
- `meetings.db` schema migration is idempotent (safe to restart)
- No hardcoded bot IDs or meeting IDs anywhere

---

## What this enables (for teams)

| Team | Before | After |
|------|--------|-------|
| Sales | Generic summary posted (sometimes) | Structured follow-up email draft, deal signals, CRM-ready action items — posted reliably |
| Finance | "TBD" action items | Action items with real owner names, decisions table, stored for audit |
| Product | Paragraph summary | Feature decisions, parking lot, action table — queryable |
| All teams | One-time Slack post | Ask questions about any past meeting via Q&A endpoint / OpenArc UI |
| All teams | Silent Slack failure | Clear warning + always persisted, even if Slack is down |
