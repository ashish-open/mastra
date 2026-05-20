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
