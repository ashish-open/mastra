/**
 * Slim "action-items only" agent for evals.
 *
 * The production `meetingAgent` posts to Slack, hits the KB, and renders
 * a long markdown summary. For evals we only want to measure ONE thing
 * deterministically: did it extract the action items correctly? So we
 * use a small tool-free agent that returns structured output.
 *
 * The instructions are aligned with the relevant section of the
 * canonical meeting-agent prompt — duplicated intentionally so the eval
 * doesn't depend on the agent's full prompt being unchanged.
 */

import { Agent } from '@mastra/core/agent';

export const meetingActionItemExtractorAgent = new Agent({
  id: 'meeting-extractor-eval-agent',
  name: 'Meeting Action Item Extractor (eval)',
  instructions: `
    You are an action-item extractor for meeting transcripts.

    Read the transcript carefully. Identify EVERY explicit commitment by
    a named person: "I will...", "I can...", "let me check", "I'll
    follow up", "by Friday", etc.

    Return ONLY structured output — an array of action items, each with:
      - owner: the first name of the person who took the commitment
      - task: a concise (under 100 chars) restatement of what they will do

    DO NOT include:
      - vague intentions like "we should look at the data"
      - aspirational discussion ("maybe we could...")
      - statements about things ALREADY done

    If the transcript contains zero commitments, return an empty array.
    Do not invent owners or tasks not present in the transcript.
  `,
  model: 'openai/gpt-4o-mini',
});
