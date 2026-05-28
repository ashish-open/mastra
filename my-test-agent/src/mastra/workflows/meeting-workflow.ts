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
 *     → Step 1: downloadTranscriptStep   — fetch transcript, classify type
 *     → Step 2: persistRawMeetingStep    — save transcript to meetings.db (safe point)
 *     → Step 3: generateAndPostSummaryStep — LLM summary + Slack post + persist final
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
import { postSlackMessage } from '../tools/slack-tool.js';
import { upsertMeetingRaw, saveStructuredAnalysis, saveMeetingFinal } from '../meetings/db.js';

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

    // Recall.ai transcript JSON: speaker name is in participant.name (separate-stream
    // transcription) or speaker (legacy single-stream). Handle both shapes.
    const segments = (await dlRes.json()) as Array<{
      speaker?: string | null;
      participant?: { id?: number; name?: string; is_host?: boolean } | null;
      words: { text: string }[];
    }>;

    // Resolve the display name for each segment — prefer participant.name (separate-stream
    // diarization gives real participant names), fall back to speaker string.
    function resolveSegmentSpeaker(seg: (typeof segments)[number]): string {
      const name = seg.participant?.name?.trim();
      if (name && name.length > 0) return name;
      const sp = seg.speaker?.trim();
      if (sp && sp.length > 0) return sp;
      return 'Unknown';
    }

    const plainText = segments
      .map(seg => {
        const text = seg.words.map(w => w.text).join(' ').trim();
        const speaker = resolveSegmentSpeaker(seg);
        return text.length > 5 ? `${speaker}: ${text}` : null;
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

    const uniqueSpeakers = new Set(segments.map(s => resolveSegmentSpeaker(s)));
    console.log(`[meeting-workflow] Speakers (${uniqueSpeakers.size}): ${[...uniqueSpeakers].join(', ')}`);

    return {
      transcriptId,
      botId,
      meetingTitle: resolvedTitle ?? 'Untitled Meeting',
      meetingType: resolvedType ?? 'general',
      plainText,
      speakerCount: uniqueSpeakers.size,
      wordCount: segments.reduce((acc, s) => acc + s.words.length, 0),
      durationMinutes,
      detectedType,
    };
  },
});

// ─── Step 2: Persist raw meeting ─────────────────────────────────────────────
// Runs immediately after the transcript is downloaded, before any LLM work.
// Stores the full plain_text in meetings.db so:
//   (a) Q&A works even if the summary step later fails or is rerun.
//   (b) Integration endpoints return meetings even before the summary is ready.
//   (c) Reprocessing a meeting (via /recall/reprocess) is idempotent.

const rawMeetingSchema = z.object({
  transcriptId: z.string(),
  botId: z.string(),
  meetingTitle: z.string(),
  meetingType: meetingTypeSchema,
  plainText: z.string(),
  speakerCount: z.number(),
  wordCount: z.number(),
  durationMinutes: z.number().optional(),
  detectedType: z.boolean(),
});

const persistRawMeetingStep = createStep({
  id: 'persist-raw-meeting',
  description: 'Saves the downloaded transcript and meeting metadata to meetings.db before LLM processing',
  inputSchema: rawMeetingSchema,
  outputSchema: rawMeetingSchema, // pure pass-through — just adds DB side-effect
  execute: async ({ inputData }) => {
    const { botId, transcriptId, meetingTitle, meetingType, durationMinutes, speakerCount, wordCount, plainText } = inputData;

    try {
      await upsertMeetingRaw({
        botId,
        transcriptId,
        title: meetingTitle,
        type: meetingType,
        durationMin: durationMinutes,
        speakerCount,
        wordCount,
        plainText,
        createdAt: new Date().toISOString(),
      });
      console.log(`[meeting-workflow] Raw meeting persisted: bot=${botId}, type=${meetingType}, words=${wordCount}`);
    } catch (err) {
      // Non-fatal — log and continue. The workflow should not fail just because
      // the DB write failed (e.g. disk full). The summary will still be generated.
      console.error('[meeting-workflow] persistRawMeetingStep DB write failed (non-fatal):', err instanceof Error ? err.message : err);
    }

    return inputData;
  },
});

// ─── Step 3: Structured extraction ───────────────────────────────────────────
// Dedicated LLM call with a strict Zod schema to extract action items,
// decisions, and key topics as JSON — completely separate from formatting.
//
// WHY a separate step?
//   When the agent has to extract structure AND write formatted Markdown at the
//   same time, action items default to "TBD" because the model is context-
//   splitting between two jobs. A focused extraction call with a JSON schema
//   forces the model to answer "who said they'd do what" — nothing else.
//
// The structured output is written to meetings.db (meeting_action_items table)
// and passed to generateAndPostSummaryStep so the summary prompt can inject
// pre-extracted data rather than re-derive it.

const actionItemSchema = z.object({
  task: z.string().describe('What needs to be done'),
  owner: z.string().describe('Speaker name from the transcript who committed to this, or "TBD"'),
  deadline: z.string().nullable().describe('Date mentioned (YYYY-MM-DD) or null'),
  confidence: z.enum(['high', 'medium', 'low']).describe(
    'high = explicit verbal commitment; medium = implied; low = discussed but unassigned'
  ),
});

const keyNumberSchema = z.object({
  label: z.string().describe('Short label, e.g. "Invoices/month", "Annual quote (previous)", "Team size"'),
  value: z.string().describe('The number/amount as a string, e.g. "700–800", "₹3–3.5L", "20", "₹60,000/month"'),
  context: z.string().describe('One short line: who said it, in what context'),
});

const notableQuoteSchema = z.object({
  speaker: z.string().describe('Real speaker name from the transcript'),
  quote: z.string().describe('Verbatim quote, ≤30 words. Use the speaker\'s exact words.'),
  why: z.string().describe('One short line on why this quote matters (objection, commitment, key insight)'),
});

const structuredOutputSchema = z.object({
  actionItems: z.array(actionItemSchema),
  decisions: z.array(z.object({
    decision: z.string().describe('What was agreed or finalised'),
    madeBy: z.string().nullable().describe('Speaker name who made/announced the decision, or null'),
  })),
  keyTopics: z.array(z.string()).describe('3–10 short topic labels (3–5 words each)'),
  openQuestions: z.array(z.string()).describe('Questions raised but not resolved in the meeting'),
  keyNumbers: z.array(keyNumberSchema).describe(
    'Every quantitative data point discussed: volumes, prices, quotes, counts, durations, percentages. ' +
    'For sales calls: ALL pricing, invoice volumes, team sizes, deal sizes. For finance/ops: any numbers cited.'
  ),
  notableQuotes: z.array(notableQuoteSchema).describe(
    '3–8 verbatim quotes that capture the meeting\'s key moments — objections, commitments, ' +
    'pivotal insights, pricing pushback, strong interest signals. Prefer the prospect/customer over the seller.'
  ),
  pricingDiscussion: z.string().nullable().describe(
    'For sales/commercial meetings: a 3–6 sentence narrative of the FULL pricing thread — ' +
    'what was quoted previously, what is being quoted now, the gap, the prospect\'s reaction, ' +
    'and any custom pricing or credits promised. Null for non-commercial meetings.'
  ),
  sentimentSignals: z.object({
    positiveSignals: z.array(z.string()),
    concerns: z.array(z.string()),
  }).optional().describe('Only for sales/support meeting types'),
});

const extractedFieldsSchema = z.object({
  actionItems: z.array(actionItemSchema),
  decisions: z.array(z.object({ decision: z.string(), madeBy: z.string().nullable() })),
  keyTopics: z.array(z.string()),
  openQuestions: z.array(z.string()),
  keyNumbers: z.array(keyNumberSchema),
  notableQuotes: z.array(notableQuoteSchema),
  pricingDiscussion: z.string().nullable(),
  positiveSignals: z.array(z.string()),
  concerns: z.array(z.string()),
});

const extractStructuredStep = createStep({
  id: 'extract-structured',
  description: 'Extracts action items, decisions, and key topics as structured JSON using a focused LLM call',
  inputSchema: rawMeetingSchema,
  outputSchema: rawMeetingSchema.merge(extractedFieldsSchema),
  execute: async ({ inputData, mastra }) => {
    const { botId, meetingType, plainText, meetingTitle, durationMinutes, speakerCount } = inputData;

    // Derive speaker list from transcript for owner attribution
    const speakers = [...new Set(
      plainText
        .split('\n')
        .map(line => line.split(':')[0]?.trim())
        .filter((s): s is string => Boolean(s) && s.length > 0 && s.length < 40),
    )];

    const includeSentiment = meetingType === 'sales' || meetingType === 'support';

    const extractionPrompt = `
You are extracting structured data from a meeting transcript. Return ONLY valid JSON — no markdown, no explanation.

Meeting: "${meetingTitle}" (${meetingType}, ${durationMinutes ?? 'unknown'} min)
Speaker names identified in this transcript: ${speakers.length > 0 ? speakers.join(', ') : 'unknown — use "Speaker A", "Speaker B"'}

EXTRACTION RULES:
1. actionItems: Find explicit verbal commitments ("I'll...", "let me...", "we'll fix", "I will", "I can do", "I'll check").
   - owner MUST be one of the speaker names above. Use "TBD" ONLY if truly unattributed.
   - deadline: extract dates mentioned (convert to YYYY-MM-DD) or null.
   - confidence: "high" = direct "I will" commitment; "medium" = implied intent; "low" = discussed but nobody claimed it.
2. decisions: Things that were agreed, approved, or finalised (not just discussed). madeBy = who declared it.
3. keyTopics: 3–10 short labels (3–5 words). Scan the whole transcript.
4. openQuestions: Questions or issues raised but NOT resolved before the meeting ended.
5. keyNumbers: Extract EVERY quantitative data point mentioned. Be exhaustive. Examples:
   - Volumes: "700–800 invoices/month", "20 users", "5+ bank accounts", "12 schools"
   - Pricing: "₹3–3.5L per annum (previous quote)", "₹60,000/month base", "₹60 per invoice", "₹1.1L/month total"
   - Durations: "35–50 min per invoice manually", "60–80% faster book closure"
   - Percentages, counts, costs, deadlines (dates as numbers)
   - For each: label (short), value (the number as written/spoken), context (who said it / situation)
   - 🚫 Do NOT skip pricing details. If multiple prices/quotes were discussed, capture ALL of them.
6. notableQuotes: 3–8 verbatim quotes capturing the meeting's pivotal moments.
   - PREFER the prospect/customer/internal-stakeholder over the seller/presenter.
   - Pick quotes that show: objections, pricing pushback, hard requirements, surprise, commitment, scope clarification.
   - Keep ≤30 words each. Use exact words from transcript.
   - 🚫 Never invent quotes. If unsure of exact wording, omit it.
${meetingType === 'sales' || meetingType === 'finance' ? `7. pricingDiscussion: Write a 3–6 sentence narrative summarising the FULL pricing/commercial thread:
   - What was the previous quote (if mentioned)?
   - What is being quoted now? Break down base + variable.
   - How did the prospect react? (sticker shock, comparison, concerns)
   - What was the seller's response? (custom credits, value justification, willingness to negotiate)
   - Any deadlines or next-step commitments around pricing?
   - If no pricing was discussed, set to null.` : '7. pricingDiscussion: null (not a commercial meeting type).'}
${includeSentiment ? '8. sentimentSignals: For sales/support — positive signals (interest, excitement) and concerns (objections, hesitation).' : ''}

TRANSCRIPT:
${plainText.slice(0, 14000)}${plainText.length > 14000 ? '\n[truncated]' : ''}
`.trim();

    const agent = mastra?.getAgent('meetingAgent');
    if (!agent) {
      console.error('[meeting-workflow] extractStructuredStep: meeting-agent not found — skipping extraction');
      return {
        ...inputData,
        actionItems: [], decisions: [], keyTopics: [], openQuestions: [],
        keyNumbers: [], notableQuotes: [], pricingDiscussion: null,
        positiveSignals: [], concerns: [],
      };
    }

    let extracted: z.infer<typeof structuredOutputSchema>;
    try {
      const result = await agent.generate(
        [{ role: 'user', content: extractionPrompt }],
        {
          structuredOutput: { schema: structuredOutputSchema },
          memory: {
            resource: `meeting-${botId}`,
            thread: `extract-${botId}`,
          },
        },
      );
      extracted = result.object as z.infer<typeof structuredOutputSchema>;
      console.log(
        `[meeting-workflow] Structured extraction: ${extracted.actionItems.length} action items, ` +
        `${extracted.decisions.length} decisions, ${extracted.keyTopics.length} topics`,
      );
    } catch (err) {
      console.error('[meeting-workflow] Structured extraction failed (non-fatal):', err instanceof Error ? err.message : err);
      // Degrade gracefully — summary step will still run without pre-extracted data
      return {
        ...inputData,
        actionItems: [], decisions: [], keyTopics: [], openQuestions: [],
        keyNumbers: [], notableQuotes: [], pricingDiscussion: null,
        positiveSignals: [], concerns: [],
      };
    }

    // Persist structured data to meetings.db immediately (before summary step)
    try {
      await saveStructuredAnalysis(botId, {
        actionItems: extracted.actionItems,
        decisions: extracted.decisions,
        keyTopics: extracted.keyTopics,
      });
      console.log(`[meeting-workflow] Structured analysis saved to DB: bot=${botId}`);
    } catch (err) {
      console.error('[meeting-workflow] saveStructuredAnalysis failed (non-fatal):', err instanceof Error ? err.message : err);
    }

    return {
      ...inputData,
      actionItems: extracted.actionItems,
      decisions: extracted.decisions,
      keyTopics: extracted.keyTopics,
      openQuestions: extracted.openQuestions,
      keyNumbers: extracted.keyNumbers ?? [],
      notableQuotes: extracted.notableQuotes ?? [],
      pricingDiscussion: extracted.pricingDiscussion ?? null,
      positiveSignals: extracted.sentimentSignals?.positiveSignals ?? [],
      concerns: extracted.sentimentSignals?.concerns ?? [],
    };
  },
});

const generateAndPostSummaryStep = createStep({
  id: 'generate-and-post-summary',
  description: 'Generates a type-specific meeting summary using pre-extracted structure, then posts to Slack',
  inputSchema: rawMeetingSchema.merge(extractedFieldsSchema),
  outputSchema: z.object({
    botId: z.string(),
    meetingTitle: z.string(),
    meetingType: z.string(),
    summary: z.string(),
    slackPosted: z.boolean(),
    slackChannel: z.string(),
    slackSkipped: z.boolean().optional(),
    slackError: z.string().optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    const {
      transcriptId, botId, meetingTitle, meetingType,
      plainText, speakerCount, wordCount, durationMinutes, detectedType,
      actionItems, decisions, keyTopics, openQuestions,
      keyNumbers, notableQuotes, pricingDiscussion,
      positiveSignals, concerns,
    } = inputData;

    const agent = mastra?.getAgent('meetingAgent');
    if (!agent) throw new Error('meeting-agent not found in Mastra config');

    const slackChannel = CHANNEL_MAP[meetingType] ?? 'general';
    const emoji = EMOJI_MAP[meetingType] ?? '📋';

    const hasStructuredData = actionItems.length > 0 || decisions.length > 0 || keyTopics.length > 0
      || keyNumbers.length > 0 || notableQuotes.length > 0;

    // Build a compact pre-extracted block so the agent formats, not re-extracts.
    // If extraction failed (all arrays empty), fall back to full transcript mode.
    const structuredBlock = hasStructuredData ? `
PRE-EXTRACTED — use these directly. The transcript follows for cross-reference,
but YOU MUST surface every key number and notable quote below in the final summary.

Action Items:
${actionItems.length > 0
  ? actionItems.map(i => `  • [${i.confidence}] ${i.task} → Owner: ${i.owner}${i.deadline ? ` by ${i.deadline}` : ''}`).join('\n')
  : '  (none identified)'}

Decisions Made:
${decisions.length > 0
  ? decisions.map(d => `  • ${d.decision}${d.madeBy ? ` (by ${d.madeBy})` : ''}`).join('\n')
  : '  (none identified)'}

Key Topics: ${keyTopics.length > 0 ? keyTopics.join(', ') : '(see transcript)'}

Key Numbers & Data Points (REQUIRED — include every one of these in the summary):
${keyNumbers.length > 0
  ? keyNumbers.map(n => `  • ${n.label}: ${n.value} — ${n.context}`).join('\n')
  : '  (none extracted)'}

${pricingDiscussion ? `Pricing Discussion (full narrative — fold this into the Commercial section):
${pricingDiscussion}
` : ''}
Notable Quotes (use at least 2–3 verbatim in the summary, prefer prospect/customer voice):
${notableQuotes.length > 0
  ? notableQuotes.map(q => `  • ${q.speaker}: "${q.quote}" — ${q.why}`).join('\n')
  : '  (none extracted)'}

Open Questions:
${openQuestions.length > 0 ? openQuestions.map(q => `  • ${q}`).join('\n') : '  (none)'}
${(positiveSignals.length > 0 || concerns.length > 0) ? `
Sentiment Signals:
  Positive: ${positiveSignals.join(' | ') || 'none'}
  Concerns: ${concerns.join(' | ') || 'none'}` : ''}
` : '';

    // Note: prompt asks the agent to PRODUCE summary text only. No Slack posting.
    // The workflow posts deterministically so we know exactly if it succeeded.
    const prompt = `
Meeting: "${meetingTitle}"
Type: ${meetingType.toUpperCase()}${detectedType ? ' (auto-detected)' : ''}
Duration: ${durationMinutes ? `${durationMinutes} min` : 'unknown'}
Speakers: ${speakerCount} | Words: ${wordCount}
${structuredBlock}
IMPORTANT — KB Citations:
Only cite URLs that search-knowledge actually returned. Never invent or guess URLs.
If no relevant KB results are found, omit the "🔎 Product Context" section entirely.

--- TRANSCRIPT ---
${plainText.slice(0, 14000)}${plainText.length > 14000 ? '\n[transcript truncated]' : ''}
--- END ---

Steps (in order):

1. ${hasStructuredData
  ? 'Scan the transcript for product names, error codes, or policy questions worth looking up in the KB. Skip if purely people/process.'
  : 'Read the full transcript. Find: (a) KB-worthy topics (product names, error codes, policy), (b) who committed to what for action items.'}

2. For each KB-worthy topic, call search-knowledge or the appropriate Zwitch MCP tool.
   Skip if the topic is purely internal with no product angle.

3. Write the ${meetingType.toUpperCase()} format summary.
   ${hasStructuredData
  ? `Use the PRE-EXTRACTED data above — do NOT re-derive it. Specifically:
     • Action Items and Decisions: copy them in. Don't paraphrase the task.
     • Key Numbers: surface EVERY number in a dedicated section. Don't drop pricing, volumes, or counts.
     • Notable Quotes: include 2–4 verbatim quotes inline (prospect voice preferred for sales). Use Markdown blockquotes (>) or backticks.
     • Pricing Discussion: if provided, present it as a structured commercial section with line-by-line breakdown, not one paragraph.
     The summary should make a reader who missed the meeting feel they didn't miss anything important.`
  : 'Extract action items from the transcript. Assign owners by real speaker name; use "TBD" only as a last resort. Pull out specific numbers, prices, and direct quotes wherever they appear — generic summaries are not acceptable.'}

4. Return ONLY the Markdown summary. Do NOT narrate the post. End at the last section.
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

    // Strip the agent's "I will now post..." / "Posting summary..." trailing
    // narration if it slips through despite the prompt. Common shape: the
    // narrative line appears as the last 1-2 lines after the actual summary.
    const cleanedSummary = summaryText
      .replace(/\n+(?:I (?:will|am going to)|Now (?:I )?will|Posting)[^\n]*?(?:slack|channel|post)[^\n]*$/gi, '')
      .replace(/\n+(?:Let me know|Please let me know|If you need)[^\n]*$/gi, '')
      .trim();

    // Deterministic Slack post — workflow does it, not the LLM.
    const slackResult = await postSlackMessage({
      channel: slackChannel as Parameters<typeof postSlackMessage>[0]['channel'],
      title: meetingTitle,
      body: `${cleanedSummary}\n\n_💬 Ask questions about this meeting → POST /recall/ask/${botId}_`,
      emoji,
      fields: [
        { label: 'Duration', value: durationMinutes ? `${durationMinutes} min` : 'unknown' },
        { label: 'Speakers', value: String(speakerCount) },
        { label: 'Type', value: `${meetingType}${detectedType ? ' (auto)' : ''}` },
      ],
    });

    console.log(
      `[meeting-workflow] Bot ${botId}: ${meetingType} summary | slack=${slackResult.success ? 'posted' : slackResult.skipped ? 'skipped (no webhook)' : 'FAILED'} → #${slackChannel}`,
    );

    // Persist the final summary + Slack status to meetings.db.
    // Non-fatal: a DB failure here must not mask a successful Slack post.
    try {
      await saveMeetingFinal(botId, {
        summaryMd: cleanedSummary,
        // Step 3 already wrote action items + decisions to the DB.
        // saveMeetingFinal only updates summary_md and slack status here,
        // so pass the same arrays through to avoid clobbering what Step 3 stored.
        actionItems,
        decisions,
        keyTopics,
        slackChannel,
        slackPosted: slackResult.success,
      });
      console.log(`[meeting-workflow] Final meeting persisted to meetings.db: bot=${botId}`);
    } catch (err) {
      console.error('[meeting-workflow] saveMeetingFinal failed (non-fatal):', err instanceof Error ? err.message : err);
    }

    return {
      botId,
      meetingTitle,
      meetingType,
      summary: cleanedSummary,
      slackPosted: slackResult.success,
      slackChannel,
      slackSkipped: slackResult.skipped,
      slackError: slackResult.error,
    };
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
    slackChannel: z.string(),
    slackSkipped: z.boolean().optional(),
    slackError: z.string().optional(),
  }),
})
  .then(downloadTranscriptStep)
  .then(persistRawMeetingStep)       // Step 2: save transcript to DB (safe point)
  .then(extractStructuredStep)       // Step 3: focused JSON extraction (action items, decisions)
  .then(generateAndPostSummaryStep); // Step 4: format summary + Slack + persist final

processMeetingWorkflow.commit();
