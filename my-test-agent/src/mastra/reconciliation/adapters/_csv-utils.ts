/**
 * Shared CSV utilities for reconciliation adapters.
 *
 * Built around one cardinal rule: **identifier columns are strings forever**.
 *
 * Why this exists
 * ---------------
 * PG/bank CSVs frequently include zero-padded numeric identifiers — 12-digit
 * NPCI RRNs like `064997745035`, beneficiary account numbers, settlement IDs.
 * Anything along the pipeline that auto-coerces these into numbers silently
 * truncates the leading zeros and breaks downstream joins.
 *
 *   064997745035 → parseFloat → 64997745035 → no longer matches the DB row.
 *
 * The bug surfaces hours later as "settlement reconciliation is off by one row"
 * — exactly the failure mode finance teams currently work around with Excel
 * Power Query. This helper makes the safe path the default path:
 *
 *   1. `parseCsvAsStrings()` reads every cell as a string. No `parseFloat`.
 *   2. Adapters opt-in to numeric coercion per column they need.
 *   3. `padToLength()` is available for known fixed-width IDs (e.g. 12-digit
 *      RRNs) so adapters can repair Excel-corrupted files at parse time AND
 *      record the normalisation in the decision audit trail.
 *
 * Per Principle 4 (every decision is reproducible and citable), any padding
 * applied is reported back via `padReport` so callers can attach a
 * `normalizations: ['zero_padded_utr']` tag to emitted RecoDecisions.
 */

// ─── CSV parsing (RFC 4180-ish: quoted fields, escaped quotes, multi-line) ──

/** Parse a single CSV line into fields. Handles quoted values and "" escapes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"' && cur === '') { inQuotes = true; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Read CSV body into rows[], joining lines with unclosed quotes (multi-line cells).
 * BOM-tolerant. Skips blank lines but preserves blank cells within rows.
 */
export function readCsvRows(body: string): string[][] {
  const rows: string[][] = [];
  // Strip UTF-8 BOM if present
  if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1);
  const rawLines = body.split(/\r?\n/);
  let buffer = '';
  for (const line of rawLines) {
    buffer = buffer ? buffer + '\n' + line : line;
    // Even number of unescaped quotes = the row is "closed"
    let quotes = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === '"') {
        if (buffer[i + 1] === '"') i++;
        else quotes++;
      }
    }
    if (quotes % 2 === 0) {
      if (buffer.trim().length > 0) rows.push(parseCsvLine(buffer));
      buffer = '';
    }
  }
  if (buffer.trim().length > 0) rows.push(parseCsvLine(buffer));
  return rows;
}

// ─── Parsed-CSV shape ────────────────────────────────────────────────────────

export interface ParsedCsv {
  /** Lower-cased column headers in declared order. */
  headers: string[];
  /**
   * Rows as plain objects keyed by header. ALL values are strings unless
   * `numericColumns` was specified at parse time (then those columns are numbers).
   * Missing cells appear as empty strings (not undefined), so adapters can
   * safely call `.length`, `.trim()`, etc. without null checks.
   */
  rows: Record<string, string | number>[];
}

export interface ParseCsvOptions {
  /** Column names (lower-cased) the adapter explicitly opts-in for numeric coercion. */
  numericColumns?: string[];
  /** Treat headers case-insensitively (default true). Set false to preserve original case. */
  lowercaseHeaders?: boolean;
}

/**
 * Parse a CSV string with **strings preserved by default** (no auto-numeric coercion).
 *
 * Identifier columns (UTR, NPCI RRN, merchant ref, account numbers, py_id) MUST
 * be left as strings or leading zeros are silently lost. Adapters explicitly
 * opt-in to numeric parsing for amount columns via `numericColumns`.
 *
 * Returns an empty `rows[]` for files with 0 or 1 lines (just header / blank).
 */
export function parseCsvAsStrings(body: string, options: ParseCsvOptions = {}): ParsedCsv {
  const lowercaseHeaders = options.lowercaseHeaders ?? true;
  const rawRows = readCsvRows(body);
  if (rawRows.length < 2) return { headers: [], rows: [] };

  const headerCells = rawRows[0];
  const headers = lowercaseHeaders ? headerCells.map(h => h.trim().toLowerCase()) : headerCells.map(h => h.trim());
  const numericSet = new Set((options.numericColumns ?? []).map(c => c.toLowerCase()));

  const rows: Record<string, string | number>[] = [];
  for (let i = 1; i < rawRows.length; i++) {
    const cells = rawRows[i];
    const row: Record<string, string | number> = {};
    for (let j = 0; j < headers.length; j++) {
      const h = headers[j];
      const raw = (cells[j] ?? '').toString();
      if (numericSet.has(h)) {
        // Numeric coercion: strip currency symbols, commas, then parseFloat.
        // We do this only for columns the adapter explicitly declared numeric.
        const cleaned = raw.replace(/[₹$,\s]/g, '');
        const n = parseFloat(cleaned);
        row[h] = Number.isFinite(n) ? n : 0;
      } else {
        row[h] = raw;
      }
    }
    rows.push(row);
  }
  return { headers, rows };
}

// ─── Leading-zero normalisation ──────────────────────────────────────────────

export interface PadReport {
  /** How many rows had a value padded for this column. */
  count: number;
  /** First few examples (raw → padded) for log/audit visibility. Capped at 5. */
  samples: Array<{ raw: string; padded: string }>;
}

/**
 * Zero-pad short string values up to a known fixed width. Mutates `row[column]`
 * if the existing value is shorter than `length` AND is all digits (e.g. RRNs).
 *
 * Returns a per-column report so the caller can attach the normalisation to
 * emitted decision metadata (e.g. `normalizations: ['zero_padded_utr']`).
 *
 * Why "all-digits" gate
 * ---------------------
 * Some identifiers look like numbers but aren't (e.g. UTRs can start with bank
 * codes: `HDFC00012345`). Only pad strings that look purely numeric — that
 * matches the "Excel ate my leading zero" failure mode and avoids accidentally
 * padding legitimately-short non-numeric refs.
 */
export function padToLength(
  rows: Record<string, string | number>[],
  column: string,
  length: number,
): PadReport {
  const report: PadReport = { count: 0, samples: [] };
  for (const row of rows) {
    const raw = row[column];
    if (typeof raw !== 'string') continue;
    if (raw.length === 0 || raw.length >= length) continue;
    if (!/^\d+$/.test(raw)) continue;
    const padded = raw.padStart(length, '0');
    row[column] = padded;
    report.count++;
    if (report.samples.length < 5) report.samples.push({ raw, padded });
  }
  return report;
}

/**
 * Helper for adapters: pick the first non-empty value from a row across a list
 * of candidate column aliases (lower-cased). Mirrors the `col(row, ...names)`
 * pattern in bank-statement.ts — moved here so every adapter can share it.
 */
export function pickColumn(
  row: Record<string, string | number>,
  ...candidates: string[]
): string | undefined {
  for (const c of candidates) {
    const v = row[c.toLowerCase()];
    if (v !== undefined && v !== '' && v !== null) return typeof v === 'string' ? v : String(v);
  }
  return undefined;
}

// ─── XLSX parsing (preserves leading zeros for text-typed cells) ─────────────

/**
 * XLSX equivalent of `parseCsvAsStrings`. Reads the first worksheet by default
 * and returns the same `ParsedCsv` shape so adapters can share code paths.
 *
 * Why we use the cell's `text` property (not `value`)
 * ---------------------------------------------------
 * ExcelJS exposes both `cell.value` (typed: number | string | Date | etc.) and
 * `cell.text` (the rendered string the user sees in Excel). For finance IDs:
 *
 *   - If the partner's export saved the cell as TEXT (e.g. `'064997745035`),
 *     both .value and .text return the same string with leading zeros intact.
 *   - If saved as NUMBER (e.g. `64997745035`), .value is the number (zeros
 *     lost) and .text is the formatted display string — still missing zeros
 *     unless the cell has a number-format mask like `000000000000`.
 *
 * Reading `.text` gives us the most permissive interpretation. We then layer
 * `padToLength()` on top per-adapter to repair known-fixed-width IDs that
 * still got truncated. Belt-and-braces.
 *
 * Numeric coercion stays opt-in via `numericColumns` exactly like CSV.
 *
 * Notes:
 *   - Multi-sheet workbooks: defaults to the first sheet. Pass `sheetName`
 *     when the partner ships a workbook with header sheets / cover pages.
 *   - Header row: assumed to be row 1, like CSV.
 *   - Dates: ExcelJS returns Date objects for date-typed cells. We render
 *     them as ISO `YYYY-MM-DD` strings to avoid Excel's locale-dependent
 *     formatting reaching our matchers.
 */
export interface ParseXlsxOptions extends ParseCsvOptions {
  /** Sheet name to read. Defaults to the first sheet. */
  sheetName?: string;
}

export async function parseXlsxAsStrings(
  file: Buffer,
  options: ParseXlsxOptions = {},
): Promise<ParsedCsv> {
  // Lazy import so the CSV-only adapters don't pay the ExcelJS load cost.
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file as unknown as ArrayBuffer);

  const sheet = options.sheetName
    ? workbook.getWorksheet(options.sheetName)
    : workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const lowercaseHeaders = options.lowercaseHeaders ?? true;
  const numericSet = new Set((options.numericColumns ?? []).map(c => c.toLowerCase()));

  // Row 1 is the header. Use values[1..N] (ExcelJS is 1-indexed).
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, cell => {
    const raw = cellAsString(cell);
    headers.push(lowercaseHeaders ? raw.trim().toLowerCase() : raw.trim());
  });

  const rows: Record<string, string | number>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.hasValues) continue;
    const out: Record<string, string | number> = {};
    for (let c = 1; c <= headers.length; c++) {
      const header = headers[c - 1];
      const cell = row.getCell(c);
      const text = cellAsString(cell);
      if (numericSet.has(header)) {
        const cleaned = text.replace(/[₹$,\s]/g, '');
        const n = parseFloat(cleaned);
        out[header] = Number.isFinite(n) ? n : 0;
      } else {
        out[header] = text;
      }
    }
    rows.push(out);
  }
  return { headers, rows };
}

/**
 * Render an ExcelJS cell to a string in a way that preserves the user's
 * intent: text cells stay text, number cells get formatted, dates → ISO.
 */
function cellAsString(cell: import('exceljs').Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  // Date cells — prefer ISO date so matchers see consistent format.
  if (v instanceof Date) {
    const yyyy = v.getUTCFullYear();
    const mm = String(v.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(v.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  // Rich text / hyperlink / formula objects — fall back to `.text` which
  // ExcelJS computes for display purposes.
  if (typeof v === 'object') {
    return cell.text ?? '';
  }
  // Numbers — use the formatted text when the cell has a number format
  // (preserves leading zeros from `000000000000` masks); otherwise toString.
  if (typeof v === 'number') {
    const t = cell.text;
    return t && t.length > 0 ? t : String(v);
  }
  // Strings + everything else
  return String(v);
}

/**
 * Mime / extension sniff helper for adapters that accept either CSV or XLSX.
 * Returns the parsed shape regardless of source format.
 */
export async function parseTabularAsStrings(
  file: Buffer,
  mime: string,
  options: ParseXlsxOptions = {},
): Promise<ParsedCsv> {
  const isXlsx =
    mime.includes('spreadsheetml') ||
    mime.includes('officedocument') ||
    mime.endsWith('xlsx') ||
    mime === 'application/vnd.ms-excel';
  if (isXlsx) {
    return parseXlsxAsStrings(file, options);
  }
  // Treat everything else as CSV — the strict mime check happens in the adapter.
  return parseCsvAsStrings(file.toString('utf-8'), options);
}
