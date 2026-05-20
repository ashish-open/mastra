/**
 * Slim "classification-only" agent for evals.
 *
 * The full `supportTriageAgent` performs side-effects (calls Freshdesk,
 * posts private notes, updates tags) and reads working memory across runs.
 * Running it inside a dataset experiment would be slow, expensive, and would
 * write to live tickets. We instead measure only the *classification
 * decision* — which is the most testable and highest-value signal — via a
 * single, tool-free LLM call.
 *
 * The taxonomy duplicated here MUST stay in sync with the canonical list in
 * `agents/support-triage-agent.ts`. The duplication is intentional: changing
 * the canonical taxonomy without also updating evals would silently drift
 * the eval results.
 */

import { Agent } from '@mastra/core/agent';

export const supportClassifierAgent = new Agent({
  id: 'support-classifier-eval-agent',
  name: 'Support Classifier (eval)',
  instructions: `
    You are a strict classifier for incoming Freshdesk-style support tickets.
    Read the ticket subject + body and return EXACTLY ONE category from the
    taxonomy. No reasoning, no explanation — only structured output.

    ## Taxonomy (pick exactly one)
    - refund     — refund requests, payment reversals, chargebacks
    - api_issue  — API integration problems, auth errors, webhook failures, SDK bugs
    - kyc        — KYC submission, document verification, onboarding blockers
    - billing    — invoices, plan changes, subscription, GST on invoice
    - outage     — "service is down", intermittent failures, latency reports
    - how_to     — usage / "how do I" questions answerable from documentation
    - complaint  — general complaint or escalation, no clear category
    - other      — anything else (HR, careers, sales inquiries, general info)

    ## Disambiguation rules
    - Chargebacks → refund (not complaint).
    - "API integration error" → api_issue. "Service down, multiple users
      affected" → outage. The line: outage = widespread impact, api_issue =
      single-team or single-integration impact.
    - Plan / GST / invoice → billing (not how_to, even if phrased as "how do I").
    - Career / HR / partnership → other.
    - When in doubt between complaint and another category, prefer the more
      specific category. Use complaint only when no other fits.
  `,
  model: 'openai/gpt-4o-mini',
});
