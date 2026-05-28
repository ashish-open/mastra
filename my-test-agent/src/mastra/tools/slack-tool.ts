/**
 * Slack Notification Tool
 *
 * Posts a message to a Slack channel via an Incoming Webhook.
 * Setup: https://api.slack.com/messaging/webhooks
 *   1. Create a Slack App → Add "Incoming Webhooks" feature
 *   2. Add to your workspace and pick a channel
 *   3. Copy the Webhook URL into .env as SLACK_WEBHOOK_URL
 *
 * For multiple channels (e.g. per team), add more env vars:
 *   SLACK_WEBHOOK_SALES, SLACK_WEBHOOK_ONBOARDING, SLACK_WEBHOOK_OPS
 * and the tool will route to the right one based on `channel`.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Maps logical channel names → env var names
const CHANNEL_MAP: Record<string, string> = {
  sales: 'SLACK_WEBHOOK_SALES',
  onboarding: 'SLACK_WEBHOOK_ONBOARDING',
  ops: 'SLACK_WEBHOOK_OPS',
  support: 'SLACK_WEBHOOK_SUPPORT',
  finance: 'SLACK_WEBHOOK_FINANCE',
  product: 'SLACK_WEBHOOK_PRODUCT',
  engineering: 'SLACK_WEBHOOK_ENGINEERING',
  hr: 'SLACK_WEBHOOK_HR',
  general: 'SLACK_WEBHOOK_URL',
  default: 'SLACK_WEBHOOK_URL',
};

function resolveWebhookUrl(channel: string): string | null {
  const envKey = CHANNEL_MAP[channel] ?? CHANNEL_MAP.default;
  return process.env[envKey] ?? process.env.SLACK_WEBHOOK_URL ?? null;
}

// ─── Plain helper — used by deterministic workflow steps ─────────────────────
//
// Same payload shape as the postToSlack tool, but exported as a plain async
// function so workflows can post WITHOUT routing through an LLM. We saw
// the meeting agent narrate "I will now post this summary to the Slack
// channel 'sales'..." as its final assistant message instead of emitting
// the tool_call — then the workflow hardcoded slackPosted:true and we
// never knew. The fix is to remove the tool from the agent entirely and
// have the workflow drive the post itself.

export interface SlackPostInput {
  channel: 'sales' | 'onboarding' | 'ops' | 'support' | 'finance' | 'product' | 'engineering' | 'hr' | 'general' | 'default';
  title: string;
  body: string;
  fields?: Array<{ label: string; value: string }>;
  emoji?: string;
}

export interface SlackPostResult {
  success: boolean;
  channel: string;
  skipped?: boolean;
  error?: string;
}

/** Post a Block Kit message to the channel's configured Incoming Webhook.
 *  Returns success=false (not throw) when no webhook is configured for that
 *  channel — workflow callers can decide whether to surface that or ignore it. */
export async function postSlackMessage(input: SlackPostInput): Promise<SlackPostResult> {
  const channel = input.channel ?? 'default';
  const webhookUrl = resolveWebhookUrl(channel);
  if (!webhookUrl) {
    console.warn(`[slack] No webhook URL configured for channel "${channel}" — skipping post`);
    return { success: false, channel, skipped: true };
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${input.emoji ?? '📋'} ${input.title}`, emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: input.body } },
  ];

  if (input.fields?.length) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      fields: input.fields.map(f => ({ type: 'mrkdwn', text: `*${f.label}*\n${f.value}` })),
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Posted by Note Taker AI · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
      },
    ],
  });

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[slack] Post failed (${res.status}): ${err}`);
    return { success: false, channel, error: `Slack post failed (${res.status}): ${err}` };
  }

  console.log(`[slack] (workflow) Posted to #${channel}: ${input.title}`);
  return { success: true, channel };
}

export const postToSlack = createTool({
  id: 'post-to-slack',
  description:
    'Posts a formatted message to a Slack channel. Use this to send meeting summaries, action items, or alerts.',
  inputSchema: z.object({
    channel: z
      .enum(['sales', 'onboarding', 'ops', 'support', 'finance', 'product', 'engineering', 'hr', 'general', 'default'])
      .default('default')
      .describe('Which team channel to post to'),
    title: z.string().describe('Bold title shown at the top of the message'),
    body: z.string().describe('Main message content (Markdown supported)'),
    fields: z
      .array(z.object({ label: z.string(), value: z.string() }))
      .optional()
      .describe('Key-value fields shown as a compact list (e.g. Duration: 45 min)'),
    emoji: z.string().default('📋').describe('Emoji prefix for the title'),
  }),
  execute: async ({ channel, title, body, fields, emoji }) => {
    const webhookUrl = resolveWebhookUrl(channel ?? 'default');
    if (!webhookUrl) {
      console.warn(`[slack] No webhook URL configured for channel "${channel}" — skipping Slack post`);
      return { success: false, channel: channel ?? 'default', skipped: true };
    }

    // Build Slack Block Kit payload for clean formatting
    const blocks: unknown[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji ?? '📋'} ${title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: body,
        },
      },
    ];

    if (fields && fields.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        fields: fields.map(f => ({
          type: 'mrkdwn',
          text: `*${f.label}*\n${f.value}`,
        })),
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Posted by Note Taker AI · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
        },
      ],
    });

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Slack post failed (${res.status}): ${err}`);
    }

    return { success: true, channel: channel ?? 'default' };
  },
});
