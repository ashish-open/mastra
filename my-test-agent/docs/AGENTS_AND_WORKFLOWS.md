# Agents and workflows

Catalog of every agent and workflow in this service, with pointers into the code and the patterns we follow.

> The reconciliation subsystem is large enough to have its own doc — [RECONCILIATION.md](RECONCILIATION.md).

---

## TL;DR

| Workflow | What it does | Trigger |
|---|---|---|
| `reconcileWorkflow` | Multi-source statement reco | `POST /api/workflows/reconcileWorkflow/start-async` |
| `deployMeetingBotWorkflow` | Send Recall.ai bot to a meeting | `POST /api/workflows/deployMeetingBotWorkflow/start-async` |
| `processMeetingWorkflow` | Summarise a meeting transcript + Slack post | Triggered by Recall.ai webhook |
| `supportTriageWorkflow` | Classify + draft L1 reply on a Freshdesk ticket | Triggered by Freshdesk webhook |

| Agent | Model | Where it's used |
|---|---|---|
| `knowledgeAgent` | gpt-4o-mini | Direct chat in Studio; tool surface for other agents |
| `supportTriageAgent` | gpt-4o | Inside `supportTriageWorkflow` |
| `meetingAgent` | gpt-4o | Inside `processMeetingWorkflow` |
| `zeusAgent` | gpt-5-mini | Direct chat in Studio (agentic payments) |
| `fuzzyMatchAgent` | gpt-4o-mini | Inside `reconcileWorkflow` (fuzzy-match step) |
| `dispositionAgent` | gpt-4o-mini | Inside `reconcileWorkflow` (disposition step) |

---

## Patterns we follow

### 1. Workflows are deterministic; agents are LLMs.
Workflow steps (`createStep`) compute things and call tools. Agents reason and write text/structured-output. The split: anything where a wrong answer costs money (or trust) goes in code. Anything ambiguous goes in an agent.

### 2. Every agent has a memory profile.
`src/mastra/memory/memory-profiles.ts` defines the working-memory template + scope for each agent. Memory is **resource-scoped**, not thread-scoped: when the support-triage workflow runs on the same ticket twice, the second run sees the first run's notes.

### 3. Tools are reusable.
We share `searchKnowledge`, `postToSlack`, `getFreshdeskTicket` etc. across agents via direct imports — not by wiring them through MCP. (We do use MCP for *external* surfaces — zwitch-mcp, Razorpay MCP — see [reconciliation MCP connector](../src/mastra/reconciliation/connectors/mcp-connector.ts).)

### 4. Structured output by default.
Every LLM step that feeds another step uses `structuredOutput: { schema: ZodSchema }`. We rarely parse free-text from agents.

---

## Reconciliation

See [RECONCILIATION.md](RECONCILIATION.md) for the full story.

| Piece | File |
|---|---|
| Workflow (7 steps) | `src/mastra/reconciliation/workflow.ts` |
| `fuzzyMatchAgent` + `dispositionAgent` | `src/mastra/reconciliation/agents.ts` |
| Configs + adapter registrations | `src/mastra/reconciliation/configs.ts` |

---

## Meeting bot

Two workflows that share one agent.

### `deployMeetingBotWorkflow`

**Trigger:** A user (or another system) calls `POST /api/workflows/deployMeetingBotWorkflow/start-async` with `{ meetingUrl, joinAt?, meetingTitle?, meetingType? }`.

**Steps:**
1. Call Recall.ai API to create a bot for the meeting URL
2. Configure the bot to dial in at `joinAt`
3. Store metadata so the second workflow has context when the bot finishes

**Output:** `{ botId, recordingId? }` — handed off to Recall.ai which fires a webhook when the recording is done.

File: [`src/mastra/workflows/meeting-workflow.ts`](../src/mastra/workflows/meeting-workflow.ts)

### `processMeetingWorkflow`

**Trigger:** Recall.ai webhook fires at `POST /recall/webhook` when the recording is processed.

**Steps:**
1. Download the transcript from Recall.ai
2. Pass it to `meetingAgent` with the meeting type ("sales" | "support" | "internal" | "other") in the prompt
3. Agent produces a structured summary: title, decisions, action-items, sentiment, follow-ups
4. Post the summary to Slack via `postToSlack` tool

**Output:** `{ summary, slackTs }` — what the user sees in their Slack channel.

### `meetingAgent`

Model: `gpt-4o`. Prompt is meeting-type aware (different fields for sales vs internal vs support). Has access to `searchKnowledge` so it can cite product docs when the meeting discussed a feature.

File: [`src/mastra/agents/meeting-agent.ts`](../src/mastra/agents/meeting-agent.ts)

**Memory profile** — scope: `resource` (per Slack channel + meeting title), so it builds context over time about a customer's prior meetings.

---

## Support Triage

Single workflow + agent. Conservative by default — drafts a **private note** for the human L1 agent; never auto-replies to the customer.

### `supportTriageWorkflow`

**Trigger:** Freshdesk webhook at `POST /freshdesk/webhook` (source-IP-allowlisted; no signature header from Freshdesk).

**Steps:**
1. Fetch the full ticket from Freshdesk (subject, body, requester, history)
2. Pass it to `supportTriageAgent`:
   - Classify intent: "billing", "kyc", "tech-support", "feature-request", "other"
   - Search the knowledge base for relevant docs (Optotax FAQs, Open Money platform answers, Zwitch via MCP)
   - Draft an L1 reply
3. Post the draft as a Freshdesk **private note** (visible to agents, not to the customer)

The route logic + private-note path is in [`src/mastra/workflows/support-triage-workflow.ts`](../src/mastra/workflows/support-triage-workflow.ts).

If the user explicitly opts in (`autoSendReply: true`), the workflow posts as a public reply instead. We **strongly** default to private note — getting it wrong on a customer-facing channel is much more expensive than a slight ops delay.

### `supportTriageAgent`

Model: `gpt-4o`. Has these tools:
- `searchKnowledge` — RAG over Optotax/Open Money KB
- Live Zwitch docs via `zwitch-mcp` MCP server
- `getFreshdeskTicket` (in case the prompt needs to drill into specific messages)

File: [`src/mastra/agents/support-triage-agent.ts`](../src/mastra/agents/support-triage-agent.ts)

**Memory profile** — scope: `resource` (per Freshdesk ticket id), so repeated triage runs on the same ticket see prior drafts.

### Why we don't auto-reply

Two reasons:
1. **Liability** — A wrong "we'll refund you" auto-reply creates a contractual obligation we can't reverse.
2. **Tone matching** — Humans are still better at calibrating apology + brand voice. The agent gives them a starting point.

We may relax this for very high-confidence categories (e.g. "where do I find my GSTR-3B?") with a separate auto-reply allow-list — but not before evals.

---

## Knowledge Bot

### `knowledgeAgent`

Model: `gpt-4o-mini`. Direct-chat in Studio for ops/support team to query the internal KB.

**Tools:**
- `searchKnowledge` — RAG via LibSQL vector store (text-embedding-3-small, 1536 dims)
- `zwitch-mcp` — live Zwitch docs (we don't ingest Zwitch into our RAG — let the source of truth own it)

**KB sources:**
- Optotax markdown (`Optotax-*.md` in repo root) — product docs, FAQ, GSTR explainers
- Open Money platform markdown (`/Users/ashish.s/Documents/AgentX/Agent_X/knowledge_base/openmoney/`)
- Zwitch docs — **NOT** ingested. Fetched live from zwitch-mcp on demand.

Rebuild the index with `pnpm ingest`. Citations use real public URLs via [`src/mastra/knowledge/url-mapping.ts`](../src/mastra/knowledge/url-mapping.ts), never internal file paths.

File: [`src/mastra/agents/knowledge-agent.ts`](../src/mastra/agents/knowledge-agent.ts)

---

## Zeus (agentic payments)

The most experimental agent in the repo.

### `zeusAgent`

Model: `gpt-5-mini`. Lets a user authorise a per-spending-budget mandate and then make autonomous payments inside it (e.g. "buy domain renewals up to ₹2000/month").

**Tools:**
- `check-agent-mandate` — verifies the requested payment is within the active mandate
- `wibmo-get-cryptogram` — gets a tokenised-card cryptogram from Wibmo's TokenHub
- `submit-agentic-payment` — submits the payment to Zwitch with the cryptogram
- Live Zwitch docs via `zwitch-mcp`

File: [`src/mastra/agents/zeus-agent.ts`](../src/mastra/agents/zeus-agent.ts)

**Memory profile** — scope: `resource` per user, so the agent remembers spending history and patterns.

### Why this is gated

Real money moves. The mandate check is **mandatory** — every payment tool call must succeed against the mandate first. Today the workflow guards this by tool ordering in the agent prompt + a runtime check in `payment-tool.ts`. In production we'd add a second mandate check at the Zwitch side.

---

## Tools

Shared tools live in `src/mastra/tools/`. Each is a thin async function wrapped in `createTool` with a Zod input schema.

| Tool | What it does | Used by |
|---|---|---|
| `freshdesk-tool.ts` | Read tickets, post notes, post replies, list groups | `supportTriageAgent`, support triage workflow |
| `freshdesk-routing.ts` | Resolve a category → Freshdesk group id | `supportTriageAgent` (for routing classified tickets) |
| `slack-tool.ts` | Post a Slack message to a configured channel | `meetingAgent`, `supportTriageAgent` |
| `recall-tool.ts` | Recall.ai bot API (create, configure, fetch transcript) | meeting workflows |
| `mandate-check-tool.ts` | Look up the active mandate, validate the requested payment | `zeusAgent` |
| `payment-tool.ts` | Submit a payment to Zwitch + Wibmo | `zeusAgent` |
| `wibmo-transact-tool.ts` | Wibmo TokenHub /transact for cryptograms | `zeusAgent` |
| `zwitch-mcp.ts` | MCP client → zwitch-mcp server | `knowledgeAgent`, `supportTriageAgent`, `zeusAgent` |
| `cashfree-mcp.ts` | MCP client → Cashfree hosted MCP (PG / payouts / secureid). All tools are **live actions** — no docs subset. Wire into `zeusAgent` or a dedicated cashfree agent only. | not auto-wired |
| `razorpay-mcp.ts` | MCP client → Razorpay hosted MCP. Exports `razorpayAllTools` (agent-facing), `razorpayRecoTools` (allow-list controlled by `RAZORPAY_RECO_TOOL_NAMES`), and `callRazorpayTool(name, args)` for **deterministic workflow calls** (used by the reco workflow's `pg-razorpay` adapter, with REST fallback). | reco workflow |

**Pattern:** every tool's `createTool` declares `inputSchema` and (where useful) `outputSchema`. The agent's tool-call args are validated at the boundary.

---

## Memory profiles

`src/mastra/memory/memory-profiles.ts` — one profile per agent.

```ts
{
  scope:        'thread' | 'resource',  // resource = per-user / per-ticket / per-meeting
  lastMessages: 5,                      // how many recent messages stay in the agent's context
  template:     '# Customer context...\n• ...',  // markdown working-memory the agent maintains
  semanticRecall: { ... },              // optional; opt-in per agent
}
```

Resource scoping is what makes the support triage agent useful across re-runs on the same ticket: the second run sees what the first run noted about the customer.

---

## How to add a new workflow

1. Create `src/mastra/workflows/your-workflow.ts`. Pattern:

```ts
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

const step1 = createStep({
  id: 'fetch',
  inputSchema: z.object({ ... }),
  outputSchema: z.object({ ... }),
  execute: async ({ inputData }) => { ... },
});

export const yourWorkflow = createWorkflow({
  id: 'yourWorkflow',
  inputSchema: z.object({ ... }),
  outputSchema: z.object({ ... }),
})
  .then(step1)
  .then(step2);

yourWorkflow.commit();
```

2. Register it in `src/mastra/index.ts`:

```ts
import { yourWorkflow } from './workflows/your-workflow';

export const mastra = new Mastra({
  workflows: { ..., yourWorkflow },
  ...
});
```

3. Mastra auto-exposes it as `POST /api/workflows/yourWorkflow/start-async`. Add a row to `/integration/info` (in `routes/integration.ts`) so OpenArc can discover it.

## How to add a new agent

1. Create `src/mastra/agents/your-agent.ts`:

```ts
import { Agent } from '@mastra/core/agent';
import { memoryProfiles } from '../memory/memory-profiles';
import { someTool } from '../tools/some-tool';

export const yourAgent = new Agent({
  name: 'Your Agent',
  instructions: `You are ...`,
  model: 'openai/gpt-4o-mini',
  tools: { someTool },
  memory: memoryProfiles.yours,  // add a profile entry too
});
```

2. Register it in `src/mastra/index.ts → agents`.

3. If it has evals, add scorers in a sibling `evals/` directory and register them under `scorers`.
