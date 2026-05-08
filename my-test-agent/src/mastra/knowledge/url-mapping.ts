/**
 * URL Mapping — internal KB filenames → public documentation URLs.
 *
 * Ported from /Users/ashish.s/Documents/AgentX/Agent_X/backend/knowledge/retrieval/url_mapping.py
 *
 * Why: Citations in customer-facing replies (Freshdesk drafts, meeting summaries)
 * MUST point to public URLs the customer can open — never internal *.md filenames
 * which leak our KB structure and don't help the reader.
 *
 * How: Each KB chunk gets a `publicUrl` field added to its metadata at ingest
 * time. Agents are instructed to cite that URL (or omit citation if missing).
 */

const ZWITCH_WEBSITE = 'https://www.zwitch.io/';
const ZWITCH_DOCS = 'https://developers.zwitch.io/';
const OPEN_MONEY_WEBSITE = 'https://open.money/';

/** Exact path → public URL */
const URL_MAPPING: Record<string, string> = {
  // ── Zwitch — General ──────────────────────────────────────────
  'zwitch/company_overview.md': ZWITCH_WEBSITE,
  'zwitch/products_overview.md': ZWITCH_WEBSITE,
  'zwitch/FAQ.md': ZWITCH_WEBSITE,
  'zwitch/PAYMENT_GATEWAY.md': `${ZWITCH_WEBSITE}#payment-gateway`,

  // ── Zwitch — API ──────────────────────────────────────────────
  'zwitch/api/00_introduction.md': `${ZWITCH_DOCS}docs/overview`,
  'zwitch/api/01_authentication.md': `${ZWITCH_DOCS}reference/authorization`,
  'zwitch/api/02_error_codes.md': `${ZWITCH_DOCS}reference/error-codes`,
  'zwitch/api/03_accounts.md': `${ZWITCH_DOCS}reference/virtual-accounts`,
  'zwitch/api/04_account_balance_statement.md': `${ZWITCH_DOCS}reference/virtual-accounts`,
  'zwitch/api/05_payments.md': `${ZWITCH_DOCS}docs/payment`,
  'zwitch/api/06_beneficiaries.md': `${ZWITCH_DOCS}docs/beneficiary-integration-flow`,
  'zwitch/api/07_transfers.md': `${ZWITCH_DOCS}reference/transfers-virtual-accounts-create-to-account-beneficiary`,
  'zwitch/api/08_verification.md': `${ZWITCH_DOCS}reference/verifications-bank-account`,
  'zwitch/api/09_bharat_connect.md': `${ZWITCH_WEBSITE}#zwitch-bill-connect`,
  'zwitch/api/10_webhooks.md': `${ZWITCH_DOCS}docs/webhook-setup`,
  'zwitch/api/11_api_constants.md': `${ZWITCH_DOCS}reference`,
  'zwitch/api/12_connected_banking.md': `${ZWITCH_DOCS}reference/connected-banking-apis`,
  'zwitch/api/13_examples_node.md': `${ZWITCH_DOCS}docs`,
  'zwitch/api/14_examples_python.md': `${ZWITCH_DOCS}docs`,
  'zwitch/api/15_layer_js.md': `${ZWITCH_DOCS}reference/layerjs`,

  // ── Zwitch — Concepts ─────────────────────────────────────────
  'zwitch/concepts/payin_vs_payout.md': `${ZWITCH_DOCS}docs/overview`,
  'zwitch/concepts/payment_token_vs_order.md': `${ZWITCH_DOCS}docs/payment`,
  'zwitch/concepts/merchant_vs_platform.md': ZWITCH_WEBSITE,
  'zwitch/concepts/zwitch_vs_open_money.md': ZWITCH_WEBSITE,

  // ── Zwitch — States ───────────────────────────────────────────
  'zwitch/states/payment_status_lifecycle.md': `${ZWITCH_DOCS}docs/payment`,
  'zwitch/states/transfer_status_lifecycle.md': `${ZWITCH_DOCS}reference/transfers-bulk`,
  'zwitch/states/verification_states.md': `${ZWITCH_DOCS}reference/verifications-bank-account`,

  // ── Zwitch — Flows ────────────────────────────────────────────
  'zwitch/flows/payin_happy_path.md': `${ZWITCH_DOCS}docs/payment`,
  'zwitch/flows/payin_failure_path.md': `${ZWITCH_DOCS}docs/payment`,
  'zwitch/flows/refund_flow.md': `${ZWITCH_DOCS}docs/payment`,
  'zwitch/flows/settlement_flow.md': `${ZWITCH_DOCS}docs/payment`,

  // ── Zwitch — Best Practices, Principles, Decisions, Risks ─────
  'zwitch/best_practices/recommended_db_schema.md': `${ZWITCH_DOCS}docs`,
  'zwitch/best_practices/production_checklist.md': `${ZWITCH_DOCS}docs`,
  'zwitch/best_practices/logging_and_audits.md': `${ZWITCH_DOCS}docs`,
  'zwitch/principles/source_of_truth.md': `${ZWITCH_DOCS}docs/webhook-setup`,
  'zwitch/principles/backend_authority.md': `${ZWITCH_DOCS}docs`,
  'zwitch/principles/idempotency.md': `${ZWITCH_DOCS}docs`,
  'zwitch/decisions/polling_vs_webhooks.md': `${ZWITCH_DOCS}docs/webhook-setup`,
  'zwitch/decisions/frontend_vs_backend_calls.md': `${ZWITCH_DOCS}docs`,
  'zwitch/decisions/retries_and_idempotency.md': `${ZWITCH_DOCS}docs`,
  'zwitch/risks/double_credit_risk.md': `${ZWITCH_DOCS}docs`,
  'zwitch/risks/webhook_signature_verification.md': `${ZWITCH_DOCS}docs/webhook-setup`,
  'zwitch/risks/reconciliation_failures.md': `${ZWITCH_DOCS}docs`,
  'zwitch/risks/compliance_boundaries.md': ZWITCH_WEBSITE,

  // ── Open Money ────────────────────────────────────────────────
  'openmoney/company_overview.md': OPEN_MONEY_WEBSITE,
  'openmoney/products_overview.md': OPEN_MONEY_WEBSITE,
  'openmoney/FAQ.md': OPEN_MONEY_WEBSITE,
  'openmoney/products/api_solutions.md': OPEN_MONEY_WEBSITE,
  'openmoney/products/banking_solutions_for_banks.md': OPEN_MONEY_WEBSITE,
  'openmoney/products/expense_management.md': OPEN_MONEY_WEBSITE,
  'openmoney/products/lending_solutions.md': OPEN_MONEY_WEBSITE,
  'openmoney/products/payroll_management.md': OPEN_MONEY_WEBSITE,
  'openmoney/concepts/what_is_open_money.md': OPEN_MONEY_WEBSITE,
  'openmoney/concepts/open_money_vs_bank.md': OPEN_MONEY_WEBSITE,
  'openmoney/concepts/open_money_vs_accounting_software.md': OPEN_MONEY_WEBSITE,
  'openmoney/concepts/open_money_product_philosophy.md': OPEN_MONEY_WEBSITE,
  'openmoney/concepts/data_ownership_and_limitations.md': OPEN_MONEY_WEBSITE,
  'openmoney/modules/receivables.md': OPEN_MONEY_WEBSITE,
  'openmoney/modules/payables.md': OPEN_MONEY_WEBSITE,
  'openmoney/modules/banking.md': OPEN_MONEY_WEBSITE,
  'openmoney/modules/cashflow_analytics.md': OPEN_MONEY_WEBSITE,
  'openmoney/modules/payments_and_payouts.md': OPEN_MONEY_WEBSITE,
  'openmoney/modules/compliance.md': OPEN_MONEY_WEBSITE,
};

/**
 * Resolve a public URL for a given KB source path.
 * Falls back to the product website if no exact mapping is found.
 */
export function publicUrlForSource(sourcePath: string): string {
  const cleanPath = sourcePath.replace(/^knowledge_base\//, '');

  // Exact match
  if (URL_MAPPING[cleanPath]) return URL_MAPPING[cleanPath];

  // Subdirectory fallback by area
  if (cleanPath.startsWith('zwitch/')) {
    if (cleanPath.includes('/api/')) return ZWITCH_DOCS;
    if (cleanPath.includes('/flows/') || cleanPath.includes('/states/')) return ZWITCH_DOCS;
    return ZWITCH_WEBSITE;
  }
  if (cleanPath.startsWith('openmoney/')) {
    return OPEN_MONEY_WEBSITE;
  }

  // Optotax (no public docs)
  if (cleanPath.toLowerCase().includes('optotax')) {
    return 'https://optotax.com/';
  }

  return '';
}

/** True if URL is a real public docs/website URL safe to send to customers. */
export function isValidPublicUrl(url: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  if (u.includes('.md')) return false;
  if (/localhost|127\.0\.0\.1|192\.168\.|10\.0\.|172\.16\./.test(u)) return false;
  if (!u.startsWith('http://') && !u.startsWith('https://')) return false;
  const validHosts = ['zwitch.io', 'open.money', 'optotax.com', 'developers.', 'dashboard.', 'www.'];
  return validHosts.some(h => u.includes(h));
}
