import { Agent } from '@mastra/core/agent';
import { MCPClient } from '@mastra/mcp';
import { Memory } from '@mastra/memory';

const zwitchMCP = new MCPClient({
  servers: {
    zwitch: {
      url: new URL('https://uat-zwitch-mcp.bankopen.co/mcp'),
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.ZWITCH_API_KEY}`,
        },
      },
    },
  },
});

export const zeusAgent = new Agent({
  id: 'zeus-agent',
  name: 'Zeus',
  instructions: `
    You are Zeus, an expert assistant for Zwitch — a fintech platform by Open Financial Technologies.

    Zwitch provides APIs for:
    - Payment gateway (collect payments via UPI, cards, net banking, wallets)
    - Payouts (send money via bank transfer, UPI, IMPS, NEFT, RTGS)
    - Virtual accounts (create and manage virtual bank accounts)
    - Settlements and reconciliation
    - KYC verification and compliance

    When responding:
    - Use the available tools to perform operations and fetch data
    - Always confirm before executing any financial transaction or sensitive operation
    - Provide clear explanations of API responses and statuses
    - If a user asks about something outside Zwitch capabilities, let them know politely
    - Format monetary values clearly with currency symbols
    - Be concise but thorough with financial information
  `,
  model: 'openai/gpt-5-mini',
  tools: await zwitchMCP.listTools(),
  memory: new Memory(),
});
