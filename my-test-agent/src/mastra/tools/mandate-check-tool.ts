import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// Agent mandate configuration — in production this comes from DB
// For MVP, hardcoded to match the demo scenario
const AGENT_MANDATES: Record<string, AgentMandate> = {
  default: {
    userId: 'demo-user-001',
    maxPerTransaction: 200000, // Rs2,000 in paise
    maxPerDay: 500000, // Rs5,000 in paise
    allowedCategories: ['SaaS', 'cloud_infra', 'developer_tools'],
    validUntil: '2026-05-02', // 30 days from now
    dailySpent: 0, // tracks daily spend — reset daily in production
  },
};

interface AgentMandate {
  userId: string;
  maxPerTransaction: number;
  maxPerDay: number;
  allowedCategories: string[];
  validUntil: string;
  dailySpent: number;
}

export const mandateCheckTool = createTool({
  id: 'check-agent-mandate',
  description:
    'Validates whether a proposed agent payment is allowed under the user-approved spending mandate. ' +
    'Call this BEFORE initiating any payment. It checks per-transaction limit, daily limit, category, and mandate expiry.',
  inputSchema: z.object({
    amountInPaise: z
      .number()
      .describe('Payment amount in paise (Rs1,650 = 165000)'),
    category: z
      .string()
      .describe('Merchant/spend category, e.g. "SaaS", "cloud_infra", "developer_tools"'),
    merchantName: z
      .string()
      .describe('Human-readable merchant name, e.g. "Notion", "Vercel"'),
    mandateId: z
      .string()
      .optional()
      .describe('Mandate ID to check against. Defaults to "default"'),
  }),
  outputSchema: z.object({
    allowed: z.boolean(),
    reason: z.string(),
    mandate: z.object({
      maxPerTransaction: z.number(),
      maxPerDay: z.number(),
      dailySpentSoFar: z.number(),
      remainingDaily: z.number(),
      allowedCategories: z.array(z.string()),
      validUntil: z.string(),
    }),
  }),
  execute: async ({ amountInPaise, category, merchantName, mandateId }) => {
    const mandate = AGENT_MANDATES[mandateId ?? 'default'];

    if (!mandate) {
      return {
        allowed: false,
        reason: `No mandate found for id "${mandateId}"`,
        mandate: {
          maxPerTransaction: 0,
          maxPerDay: 0,
          dailySpentSoFar: 0,
          remainingDaily: 0,
          allowedCategories: [],
          validUntil: '',
        },
      };
    }

    if (new Date() > new Date(mandate.validUntil)) {
      return buildResult(false, 'Mandate has expired. User must renew.', mandate);
    }

    if (amountInPaise > mandate.maxPerTransaction) {
      return buildResult(
        false,
        `Amount Rs${(amountInPaise / 100).toFixed(2)} exceeds per-transaction limit of Rs${(mandate.maxPerTransaction / 100).toFixed(2)}`,
        mandate,
      );
    }

    if (mandate.dailySpent + amountInPaise > mandate.maxPerDay) {
      return buildResult(
        false,
        `This payment would exceed the daily limit. Spent today: Rs${(mandate.dailySpent / 100).toFixed(2)}, ` +
          `limit: Rs${(mandate.maxPerDay / 100).toFixed(2)}`,
        mandate,
      );
    }

    const categoryLower = category.toLowerCase();
    const allowed = mandate.allowedCategories.some((c) => c.toLowerCase() === categoryLower);
    if (!allowed) {
      return buildResult(
        false,
        `Category "${category}" is not in the allowed list: ${mandate.allowedCategories.join(', ')}`,
        mandate,
      );
    }

    mandate.dailySpent += amountInPaise;

    return buildResult(
      true,
      `Payment of Rs${(amountInPaise / 100).toFixed(2)} to ${merchantName} (${category}) approved under mandate.`,
      mandate,
    );
  },
});

function buildResult(allowed: boolean, reason: string, mandate: AgentMandate) {
  return {
    allowed,
    reason,
    mandate: {
      maxPerTransaction: mandate.maxPerTransaction,
      maxPerDay: mandate.maxPerDay,
      dailySpentSoFar: mandate.dailySpent,
      remainingDaily: mandate.maxPerDay - mandate.dailySpent,
      allowedCategories: mandate.allowedCategories,
      validUntil: mandate.validUntil,
    },
  };
}
