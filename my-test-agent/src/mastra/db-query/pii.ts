/**
 * PII deny-list for the db-query agent.
 *
 * Purpose:
 *
 *   Even with a read-only Postgres role, a curious user could still SELECT
 *   raw PII (emails, phone numbers, account numbers, etc.) just by asking.
 *   This module holds the canonical list of columns we never return in
 *   clear text, and provides two helpers used by the runner:
 *
 *     - `isPii(connId, schema, table, column)` — fast lookup
 *     - `maskValue(value)`                      — deterministic redaction
 *
 *   The runner walks each result row, redacts any field whose source column
 *   is PII, and reports back the list of redacted columns so the narrator
 *   can say "(email masked)" instead of silently dropping data.
 *
 * Why a static config instead of column comments / introspection:
 *
 *   - Trustworthy: a deny-list is reviewed in code review and version-
 *     controlled. A column comment can be edited by anyone with DBA access.
 *   - Explicit: easier to audit "what is hidden from the agent" by reading
 *     one file.
 *   - Flexible: lets us mask derived columns and aliases that don't exist
 *     in pg_attribute.
 *
 * Adding a new entry:
 *
 *   Add to `PII_DENY_LIST` below, keyed by connection id. Patterns are case-
 *   insensitive. Use wildcards sparingly — false-positive masking is much
 *   harder to debug than a missed entry.
 */

import type { ConnectionId } from './types.js';

/**
 * One deny-list entry. Either `table` is set (specific table) or `tablePattern`
 * (regex applied case-insensitively to `schema.table`). `columnPattern` is the
 * column-name regex; case-insensitive.
 */
export interface PiiRule {
  /** Schema (default `public`). Ignored if `tablePattern` is set. */
  schema?: string;
  table?: string;
  tablePattern?: RegExp;
  columnPattern: RegExp;
  /** Why it's masked. Surfaced in logs for auditability. */
  reason: string;
}

/**
 * Canonical deny-list. Per connection id.
 *
 * Default policy: mask anything that looks like an email, phone, PAN, bank
 * account, IFSC-keyed account, government id, OTP, secret, token, password.
 * Override / extend per-connection as needed.
 */
export const PII_DENY_LIST: Record<string, PiiRule[]> = {
  // Catch-all rules applied to every connection. Cheap and worth it.
  '*': [
    { columnPattern: /(^|_)email(_|$)/i, reason: 'email address' },
    { columnPattern: /(^|_)phone(_|$)|(^|_)mobile(_|$)|msisdn/i, reason: 'phone / mobile number' },
    { columnPattern: /(^|_)pan(_|$)/i, reason: 'PAN' },
    { columnPattern: /(^|_)aadhaar|aadhar/i, reason: 'Aadhaar' },
    { columnPattern: /(^|_)gstin?(_|$)/i, reason: 'GSTIN' },
    { columnPattern: /account_number|bank_account|accountno/i, reason: 'bank account number' },
    { columnPattern: /password|pwd|secret|api_key|token(_|$)|otp(_|$)/i, reason: 'credential / secret' },
    { columnPattern: /payer_vpa|^vpa$|upi_id/i, reason: 'UPI handle' },
    { columnPattern: /(^|_)dob(_|$)|date_of_birth/i, reason: 'date of birth' },
  ],
  // Per-connection overrides go here. Example:
  // openarc: [{ schema: 'public', table: 'users', columnPattern: /full_name/i, reason: 'PII per policy' }],
};

/**
 * True iff the (connection, schema, table, column) tuple matches any rule.
 *
 * Implementation note: this is called per-cell on result rows; we accept the
 * small allocation cost (Map.get + a few regex tests) because result-set
 * sizes are capped at a few thousand rows.
 */
export function isPii(
  connectionId: ConnectionId,
  schema: string,
  table: string,
  column: string,
): { masked: boolean; reason?: string } {
  const candidates = [...(PII_DENY_LIST['*'] ?? []), ...(PII_DENY_LIST[connectionId] ?? [])];
  const fqtn = `${schema}.${table}`;

  for (const rule of candidates) {
    const tableMatches =
      rule.tablePattern?.test(fqtn) ??
      ((rule.schema ?? 'public') === schema && rule.table === table) ??
      // Both schema/table and tablePattern omitted => rule applies to every table.
      (rule.schema === undefined && rule.table === undefined && rule.tablePattern === undefined);

    if (!tableMatches) continue;
    if (rule.columnPattern.test(column)) {
      return { masked: true, reason: rule.reason };
    }
  }

  return { masked: false };
}

/**
 * Replace a value with its masked form. Keeps enough of the original to be
 * useful in narrative ("the row exists, but the email is masked"). Never
 * returns the original value — even for already-empty strings, return the
 * `null`/empty placeholder so behavior is uniform.
 */
export function maskValue(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  const s = String(value);
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
