/**
 * CSV utilities for the report-pack builder.
 *
 * Designed for FINANCE-TEAM-OPENABLE output:
 *   - Strings (UTRs, py_ids, RRN) preserved verbatim — leading zeros kept.
 *   - Money rendered as plain numeric strings (not floats, not localised).
 *     The bucket file is a settlement upload candidate, not a display
 *     artifact — Excel can format it however the user wants.
 *   - Dates written as ISO `YYYY-MM-DD` so Excel doesn't auto-convert them
 *     to its locale (US dates vs Indian dates is a real bug we are NOT
 *     reintroducing).
 *   - Every value RFC 4180 escaped (quotes, commas, newlines).
 *
 * Two output shapes:
 *
 *   toCsv(rows, columns)
 *     - rows: array of plain objects keyed by column name
 *     - columns: ordered list of headers (also column keys)
 *     - emits header row + one row per record
 *     - empty rows → just the header line (header-only CSV is valid)
 *
 *   csvEscape(value)
 *     - returns a value safe for embedding inside a CSV cell
 */

/**
 * RFC 4180 cell escape. Quotes get doubled. Strings containing commas, quotes,
 * or newlines get wrapped in quotes. null / undefined become empty cells.
 *
 * Numbers and booleans are toString'd. Dates as ISO date strings (caller is
 * expected to pre-format; this function does not implicitly format Date
 * instances — explicit > implicit for finance data).
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  // Wrap when the value contains a comma, double quote, or any line break.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build a CSV string from an array of records and an ordered column list.
 * Always emits the header line first; trailing newline included.
 *
 * Empty `rows[]` → just the header. Useful for "the leg matched zero rows
 * so its matched.csv is empty" — finance team still sees the file shape.
 */
export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: ReadonlyArray<keyof T & string>): string {
  const lines: string[] = [];
  lines.push(columns.map(c => csvEscape(c)).join(','));
  for (const row of rows) {
    lines.push(columns.map(c => csvEscape(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Format paise as a plain rupee string without locale separators. Used by
 * the upload-format CSVs that downstream systems re-parse.
 *
 *   12345 → "123.45"     (no ₹, no commas)
 *   -250  → "-2.50"
 *
 * For display-only columns we keep the localised "₹1,23,456.78" elsewhere.
 */
export function paiseToRupeeString(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '';
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const pp = String(abs % 100).padStart(2, '0');
  return `${sign}${rupees}.${pp}`;
}
