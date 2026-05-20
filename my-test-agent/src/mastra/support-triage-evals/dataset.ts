/**
 * Labeled synthetic tickets for support-triage classification eval.
 *
 * IMPORTANT: every case here is SYNTHETIC. Real Freshdesk tickets contain
 * customer PII (names, emails, phone numbers, account IDs, amounts) — per
 * Bank Open compliance rules, we never put live data in the repo or in eval
 * datasets. When promoting real tickets to this dataset, redact aggressively:
 *   - names              → "Customer", "Mr. X"
 *   - emails             → cust@example.com
 *   - phones             → +91-XXXXX-XXXXX
 *   - PAN / Aadhaar      → XXXXX9999X / XXXX-XXXX-9999
 *   - amounts            → ₹X,XXX
 *   - merchant ref IDs   → ORD-XXXXX
 *   - any account number → keep last 4 only, mask the rest
 *
 * Each case is one ticket (subject + body) plus the expected category, plus
 * an optional `routeHint` to capture which team the body content suggests
 * (used by a future routing scorer).
 */

/** Category taxonomy — MUST match the values used by the support triage agent. */
export const SUPPORT_CATEGORIES = [
  'refund',
  'api_issue',
  'kyc',
  'billing',
  'outage',
  'how_to',
  'complaint',
  'other',
] as const;
export type SupportCategory = typeof SUPPORT_CATEGORIES[number];

export interface SupportEvalCase {
  /** Short, unique, human-readable. */
  name: string;
  /** Synthetic ticket subject. */
  subject: string;
  /** Synthetic ticket body. */
  body: string;
  /** What category should the classifier pick? */
  expectedCategory: SupportCategory;
  /** What product surface the content hints at. */
  product?: 'zwitch' | 'open-money' | 'optotax' | 'hdfc' | 'banking-stack' | 'lending' | 'unknown';
  /** Free-text notes for reviewers — why this case is interesting. */
  notes?: string;
}

export const SUPPORT_CASES: SupportEvalCase[] = [
  // ─── refund ─────────────────────────────────────────────────────────────
  {
    name: 'straightforward refund request',
    subject: 'Refund for double charged payment',
    body: 'I was charged twice for order ORD-XXXXX on the same day. Please refund the duplicate amount of ₹X,XXX to my original payment method.',
    expectedCategory: 'refund',
    product: 'zwitch',
  },
  {
    name: 'chargeback dispute',
    subject: 'Chargeback raised for transaction',
    body: 'The customer has raised a chargeback for the transaction. We have shipping proof and delivery confirmation. How do we contest this?',
    expectedCategory: 'refund',
    product: 'zwitch',
    notes: 'Chargebacks are refund-family per taxonomy.',
  },

  // ─── api_issue ──────────────────────────────────────────────────────────
  {
    name: 'webhook delivery failing',
    subject: 'Payment webhooks not reaching our endpoint',
    body: 'We integrated the payment_link.paid webhook two weeks ago. Until yesterday it was working. Since this morning we have not received any webhook even though payments are succeeding in the dashboard. We are returning 200 OK to all retries.',
    expectedCategory: 'api_issue',
    product: 'zwitch',
  },
  {
    name: 'auth 401 errors after key rotation',
    subject: 'Getting 401 unauthorized on all API calls',
    body: 'We rotated our API key in production yesterday. All API calls now return 401 unauthorized: "Invalid signature". Postman with the new key works fine, only our Node SDK fails. SDK version 4.2.1.',
    expectedCategory: 'api_issue',
    product: 'zwitch',
  },
  {
    name: 'SDK bug — wrong currency in response',
    subject: 'Order amount returned in wrong currency',
    body: 'When I create an order with currency=INR the GET /orders/:id response returns currency=USD but amount is the INR value. This breaks our reconciliation. Reproducible 100% on Node SDK 4.3.0.',
    expectedCategory: 'api_issue',
    product: 'zwitch',
  },

  // ─── kyc ────────────────────────────────────────────────────────────────
  {
    name: 'KYC document rejected',
    subject: 'My KYC documents were rejected, no reason given',
    body: 'I uploaded my PAN and Aadhaar three days ago for business onboarding. The status shows "rejected" but there is no reason. Please tell me what to upload.',
    expectedCategory: 'kyc',
    product: 'open-money',
  },
  {
    name: 'video KYC slot booking',
    subject: 'Cannot book V-KYC slot',
    body: 'The V-KYC slot booking page says "no slots available" since two days. My account onboarding is stuck. Please help.',
    expectedCategory: 'kyc',
    product: 'open-money',
  },

  // ─── billing ────────────────────────────────────────────────────────────
  {
    name: 'GST on invoice',
    subject: 'Need GST number on monthly invoice',
    body: 'Our finance team needs our GSTIN printed on the monthly subscription invoice. Currently the invoice has no GSTIN. Account email cust@example.com.',
    expectedCategory: 'billing',
    product: 'optotax',
  },
  {
    name: 'plan upgrade request',
    subject: 'Want to upgrade from Starter to Pro',
    body: 'How do I upgrade my plan? I want to move from Starter to Pro to get higher API rate limits. Will the change be prorated?',
    expectedCategory: 'billing',
    product: 'zwitch',
  },

  // ─── outage ─────────────────────────────────────────────────────────────
  {
    name: 'dashboard 500s',
    subject: 'Dashboard returning 500 errors',
    body: 'The merchant dashboard is throwing 500 server error since 11:30 AM. Tried different browsers and incognito — same result. Multiple teammates affected.',
    expectedCategory: 'outage',
    product: 'zwitch',
  },
  {
    name: 'intermittent payment failures',
    subject: 'Random payment failures every few minutes',
    body: 'Roughly 1 in 10 payments are failing with "internal error" on the gateway since last evening. Working most of the time but the failure rate is high enough to impact customers.',
    expectedCategory: 'outage',
    product: 'zwitch',
    notes: 'Could be classified as api_issue too — outage when widespread/intermittent.',
  },

  // ─── how_to ─────────────────────────────────────────────────────────────
  {
    name: 'integration question — payment links',
    subject: 'How to create a payment link with expiry',
    body: 'I want to create a payment link that auto-expires after 24 hours. Could you point me to the right API endpoint and parameter?',
    expectedCategory: 'how_to',
    product: 'zwitch',
  },
  {
    name: 'optotax GSTR-1 filing question',
    subject: 'How to file GSTR-1 with no sales',
    body: 'We had zero sales in May. Do we still need to file GSTR-1? How to file a nil return through Optotax?',
    expectedCategory: 'how_to',
    product: 'optotax',
  },

  // ─── complaint ──────────────────────────────────────────────────────────
  {
    name: 'unresponsive support escalation',
    subject: 'Escalation — no response in 5 days',
    body: 'I have raised three tickets in the last 5 days about my account being suspended and have not received a single response. This is unacceptable. Please escalate.',
    expectedCategory: 'complaint',
    product: 'open-money',
  },

  // ─── other ──────────────────────────────────────────────────────────────
  {
    name: 'careers / HR — out of scope',
    subject: 'Application for software engineer role',
    body: 'I came across your careers page and would like to apply for the senior software engineer position. Attached is my resume.',
    expectedCategory: 'other',
    product: 'unknown',
  },
  {
    name: 'partnership inquiry',
    subject: 'Strategic partnership proposal',
    body: 'We run a logistics SaaS in the same SMB segment. Would love to explore a co-marketing or integration partnership. Who is the right person to talk to?',
    expectedCategory: 'other',
    product: 'unknown',
  },
];
