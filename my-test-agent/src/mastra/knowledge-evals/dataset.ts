/**
 * Labeled questions for the Knowledge Bot retrieval eval.
 *
 * Each case is one synthetic user question + the expected source document
 * (the markdown filename, matching the `source` field on KB rows). The eval
 * measures retrieval recall@k: did `searchKnowledge` return the expected
 * source in the top-K results?
 *
 * IMPORTANT: questions here are SYNTHETIC. We do NOT promote real Freshdesk
 * questions verbatim — they often contain PII. To add a case from a real
 * ticket, rewrite the question in your own words and redact any IDs/PII.
 *
 * Expanding coverage:
 *   - aim for 2-3 cases per major source doc in the KB
 *   - cover both products (optotax + open-money) proportionally
 *   - include at least one "off-topic, should return nothing useful" case
 *     so we can also measure precision (separate scorer in follow-up).
 */

export interface KnowledgeEvalCase {
  name: string;
  question: string;
  product?: 'optotax' | 'open-money' | 'connected-banking';
  /**
   * Expected source filename — matches the `source` field on KB rows.
   * Accept any of these (substring match, case-insensitive) in retrieved top-K.
   */
  expectedSources: string[];
  notes?: string;
}

export const KNOWLEDGE_CASES: KnowledgeEvalCase[] = [
  // ─── Optotax ────────────────────────────────────────────────────────────
  {
    name: 'optotax pricing',
    question: 'How much does Optotax cost? Is there a free tier?',
    product: 'optotax',
    expectedSources: ['Optotax-Website-2026.md', '_FAQ - Optotax.md'],
  },
  {
    name: 'optotax — what GSTR reports are supported',
    question: 'Which GSTR returns can I file using Optotax?',
    product: 'optotax',
    expectedSources: ['Explainer-GSTR_Reports_OPTOTAX.md', 'OPTOTAX PRD.md'],
  },
  {
    name: 'optotax — who is the target user',
    question: 'Is Optotax built for CAs or for business owners directly?',
    product: 'optotax',
    expectedSources: ['OPTOTAX PRD.md', 'Optotax-Website-2026.md'],
  },

  // ─── Open Money — concepts ──────────────────────────────────────────────
  {
    name: 'open-money — what is it',
    question: 'What is Open Money in one paragraph?',
    product: 'open-money',
    expectedSources: ['openmoney/concepts/what_is_open_money.md', 'openmoney/company_overview.md'],
  },
  {
    name: 'open-money vs bank',
    question: 'How is Open Money different from a regular bank account?',
    product: 'open-money',
    expectedSources: ['openmoney/concepts/open_money_vs_bank.md'],
  },
  {
    name: 'open-money vs accounting software',
    question: 'How does Open Money compare to Tally or Zoho Books?',
    product: 'open-money',
    expectedSources: ['openmoney/concepts/open_money_vs_accounting_software.md'],
  },

  // ─── Open Money — data semantics ────────────────────────────────────────
  {
    name: 'open-money cashflow calculation',
    question: 'How is cashflow calculated in Open Money?',
    product: 'open-money',
    expectedSources: ['openmoney/data_semantics/cashflow_calculation.md'],
  },
  {
    name: 'open-money reconciliation logic',
    question: 'How does the reconciliation logic work in Open Money?',
    product: 'open-money',
    expectedSources: ['openmoney/data_semantics/reconciliation_logic.md'],
  },
  {
    name: 'open-money overdue calculation',
    question: 'How does Open Money decide an invoice is overdue?',
    product: 'open-money',
    expectedSources: ['openmoney/data_semantics/overdue_calculation_logic.md'],
  },

  // ─── Open Money — decisions / workflows ─────────────────────────────────
  {
    name: 'invoice vs payment link',
    question: 'When should I use an invoice vs a payment link?',
    product: 'open-money',
    expectedSources: ['openmoney/decisions/invoice_vs_payment_link.md'],
  },
  {
    name: 'handling failed payouts',
    question: 'What happens when a payout fails?',
    product: 'open-money',
    expectedSources: ['openmoney/decisions/handling_failed_payouts.md'],
  },

  // ─── Open Money — company ───────────────────────────────────────────────
  {
    name: 'company history',
    question: 'When was Open Money founded?',
    product: 'open-money',
    expectedSources: ['openmoney/company/history_and_foundation.md'],
  },
  {
    name: 'company funding',
    question: 'Who are the investors in Open Money?',
    product: 'open-money',
    expectedSources: ['openmoney/company/funding_and_investors.md'],
  },

  // ─── Cross-product / negative test ──────────────────────────────────────
  {
    name: 'zwitch question — should not match',
    question: 'How do I create a Zwitch virtual account?',
    expectedSources: [],
    notes: 'Zwitch docs are not in this KB. Expect no matches OR low-score matches that the agent should ignore.',
  },
];
