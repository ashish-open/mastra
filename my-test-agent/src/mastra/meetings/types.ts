/**
 * Shared types for the meetings persistence layer.
 *
 * meetings table  — one row per bot run (keyed on botId)
 * meeting_action_items table — normalised rows, one per extracted action item
 *
 * Raw fields are populated in Step 2 (persistRawMeetingStep).
 * Final fields (summaryMd, slackPosted, etc.) are set in Step 4 after the
 * LLM summary is generated and the Slack post is confirmed.
 */

export interface Meeting {
  botId: string;
  transcriptId: string;
  title: string;
  type: string;
  durationMin: number | null;
  speakerCount: number;
  wordCount: number;
  plainText: string;    // full transcript — stored so Q&A works without re-fetching from Recall
  createdAt: string;    // ISO-8601, set when raw is persisted
  processedAt: string | null; // ISO-8601, set when final summary is saved
  summaryMd: string | null;   // formatted Markdown that was posted to Slack
  actionItems: ActionItem[] | null; // parsed from JSON column
  decisions: Decision[] | null;     // parsed from JSON column
  keyTopics: string[] | null;
  slackChannel: string | null;
  slackPosted: boolean;
}

export interface ActionItem {
  task: string;
  owner: string;       // real speaker name or "TBD"
  deadline: string | null; // "YYYY-MM-DD" or null
  confidence: 'high' | 'medium' | 'low';
}

export interface Decision {
  decision: string;
  madeBy: string | null;
}

/** Row shape returned from listMeetings (no plainText — too large for list view) */
export interface MeetingListItem {
  botId: string;
  title: string;
  type: string;
  durationMin: number | null;
  speakerCount: number;
  createdAt: string;
  slackChannel: string | null;
  slackPosted: boolean;
}

/** Input for upsertMeetingRaw */
export interface RawMeetingInput {
  botId: string;
  transcriptId: string;
  title: string;
  type: string;
  durationMin: number | undefined;
  speakerCount: number;
  wordCount: number;
  plainText: string;
  createdAt: string;
}

/** Input for saveMeetingFinal */
export interface FinalMeetingInput {
  summaryMd: string;
  actionItems: ActionItem[];
  decisions: Decision[];
  keyTopics: string[];
  slackChannel: string;
  slackPosted: boolean;
}
