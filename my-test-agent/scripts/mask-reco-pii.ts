#!/usr/bin/env tsx
/**
 * mask-reco-pii.ts — Locally anonymise reconciliation input files before sharing.
 *
 * Purpose
 * -------
 * Finance team's real PG / bank / MIS files contain customer PII (VPAs, phone
 * numbers, names, account numbers, narrations). The reco engine doesn't need
 * any of that — it joins on UTR / merchant ref / amount / date. This script
 * keeps the join-relevant fields verbatim and replaces PII with **stable
 * pseudo-IDs** so the same `9876543210@ybl` becomes the same `user_a1b2@ybl`
 * across every file you mask, preserving join behaviour.
 *
 * Quick start
 * -----------
 *   # Put raw files in ./pii-raw/  (CSV only — convert XLSX with LibreOffice first)
 *   tsx scripts/mask-reco-pii.ts ./pii-raw ./pii-masked
 *
 *   # Output:
 *   #   ./pii-masked/<filename>.csv       — masked CSVs (safe to share)
 *   #   ./pii-masked/_mask-report.txt     — per-column summary
 *   #   ./pii-salt.local                  — auto-generated random salt (KEEP LOCAL)
 *
 * The salt file lives outside the output directory on purpose: never share it
 * (sharing salt + masked output makes brute-forcing pseudo-IDs trivial for
 * short input domains like 10-digit phone numbers).
 *
 * Masking rules (column-name driven, case-insensitive contains-match)
 * ------------------------------------------------------------------
 * KEEP verbatim (these ARE the reco signal):
 *   utr, rrn, npci_ref, ref_no, transaction_id, txn_id, payment_id,
 *   order_id, merchant_ref, merchant_ref_id, settlement_id, batch_id,
 *   amount, txn_amount, paise, value, credit, debit, dr, cr, deposit,
 *   withdrawal, date, time, timestamp, created_at, status, response_code,
 *   npci_code, error_code, mid, mcc, payment_mode, txn_mode, channel
 *
 * HASH to stable pseudo-IDs (8 hex chars from HMAC-SHA256):
 *   payer_vpa, payee_vpa, vpa, upi_id     → user_<hash>@<bank_tld_preserved>
 *   phone, mobile, msisdn, contact         → 91XXXXX<hash4digits>
 *   email                                  → user_<hash>@example.test
 *   payer_name, payee_name, customer_name  → "Customer <hash>"
 *   merchant_name, business_name           → "Merchant <hash>"
 *   account_no, account_number, acc_no,
 *   beneficiary_account                    → XXXXXXXX<last4>
 *   pan, aadhaar, gstin, ifsc              → fully masked (8-char hash, no semantics retained)
 *   address, city, pincode                 → "[masked]"
 *
 * NARRATION fields (description, narration, particulars, remarks):
 *   In-line scrub PII patterns inside the value (VPAs, 10-digit phones,
 *   long account numbers) while preserving partner/merchant-side keywords
 *   useful for reco (e.g. "NEFT", "UPI/...", "RAZORPAY", "NPCI").
 *
 * Unknown columns: pass-through verbatim. The report at the end lists which
 * columns were touched and which were passed through — review it before
 * sharing the output.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 2 || args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: tsx scripts/mask-reco-pii.ts <inputDir> <outputDir> [--salt-file <path>]

The salt file is auto-created if it doesn't exist (default: ./pii-salt.local).
KEEP IT LOCAL — sharing it makes the pseudo-IDs reversible.`);
  process.exit(args.length < 2 ? 1 : 0);
}

const inputDir = resolve(args[0]);
const outputDir = resolve(args[1]);
const saltFlagIdx = args.indexOf('--salt-file');
const saltPath = saltFlagIdx >= 0 ? resolve(args[saltFlagIdx + 1]) : resolve('./pii-salt.local');

if (!existsSync(inputDir)) {
  console.error(`Input directory not found: ${inputDir}`);
  process.exit(1);
}
mkdirSync(outputDir, { recursive: true });

// ─── Salt ────────────────────────────────────────────────────────────────────

let salt: string;
if (existsSync(saltPath)) {
  salt = readFileSync(saltPath, 'utf-8').trim();
  if (!salt) {
    console.error(`Salt file exists but is empty: ${saltPath}`);
    process.exit(1);
  }
  console.log(`[mask] using existing salt from ${saltPath}`);
} else {
  salt = randomBytes(32).toString('hex');
  writeFileSync(saltPath, salt + '\n', { mode: 0o600 });
  console.log(`[mask] generated new salt at ${saltPath} (chmod 0600). DO NOT SHARE.`);
}

// ─── Stable hashes ───────────────────────────────────────────────────────────

const hashCache = new Map<string, string>();
function shortHash(value: string, len = 8): string {
  const key = `${len}:${value}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const hex = createHmac('sha256', salt).update(value).digest('hex').slice(0, len);
  hashCache.set(key, hex);
  return hex;
}

// ─── Column classification ───────────────────────────────────────────────────

type MaskKind =
  | 'keep'
  | 'vpa'
  | 'phone'
  | 'email'
  | 'person_name'
  | 'merchant_name'
  | 'account_no'
  | 'identity_id'   // PAN / Aadhaar / GSTIN / IFSC — opaque hash
  | 'address'
  | 'ip_address'
  | 'narration'
  | 'unknown';

const COLUMN_RULES: Array<{ kind: MaskKind; needles: string[] }> = [
  // Keep — reco-critical join keys + amounts + status + opaque business IDs.
  { kind: 'keep', needles: [
    // join keys
    'utr', 'rrn', 'npci_ref', 'ref_no', 'ref no', 'reference', 'urn',
    'transaction_id', 'txn_id', 'txnid', 'transactionid', 'trnsaction id', // typo seen in YES MIS
    'payment_id', 'paymentid', 'order_id', 'orderid', 'order_no', 'order no',
    'merchant_ref', 'merchantref', 'settlement_id', 'settlementid',
    'batch_id', 'batchid', 'cheque_no', 'cheque no', 'rownum',
    'bank_reference', 'bankreferencenumber', 'bank reference number',
    'companies_id', 'pg_txn_ref_num',
    'payment_request_id', 'payment_gateways_name', 'transaction_type_name',
    'pg_merchant_id', 'pg merchant id',
    // amounts / accounting (NOT customer-account-number — that's mask)
    'amount', 'txn_amount', 'paise', 'value', 'credit', 'debit', 'deposit', 'withdrawal',
    'fee', 'tax', 'tdr', 'gst', 'charge', 'charges',
    'msf_amount', 'msf tax amount', 'pg_fee', 'pg_tax', 'pg_total_fee', 'pg_net_amount',
    'open_tdr', 'open_gst', 'open_net_amount', 'open_total_charges',
    'convenience_fee', 'instant_settlement_charge',
    'running_balance', 'balance',
    // dates / time
    'date', 'time', 'timestamp', 'created_at', 'createdat',
    'value_date', 'value date', 'txn_date', 'txn date', 'transaction_date',
    'dat_post', 'settled_to_open_date', 'settled_to_merchant_date',
    // status / type / classification
    'status', 'response_code', 'response code', 'npci_code', 'npci code',
    'error_code', 'error code', 'drcr_flag', 'dr/cr', 'flag',
    'mid', 'mcc', 'payment_mode', 'txn_mode', 'channel', 'currency',
    'transaction_type', 'trans_type', 'trans type', 'pay_type', 'pay type',
    'pg_transaction_status', 'ss_status', 'settlement_status', 'payout_status',
    // device / channel (non-PII per RBI; device-type tells us UPI app, not who)
    'device_type', 'device type', 'app', 'device_os', 'device os', 'payer a/c type',
    // manual VLOOKUP flag columns finance team adds: 'Bank', 'Consolidated', 'PG incoming'
    'bank', 'consolidated', 'pg incoming', 'pg_incoming',
  ]},
  // Hash — VPAs first (more specific than 'name'). 'virtual address' is YES bank's
  // column name for VPA — must match BEFORE the generic 'address' rule below.
  { kind: 'vpa',           needles: ['vpa', 'upi_id', 'upi id', 'upiid', 'virtual address', 'virtual_address', 'virtualaddress'] },
  { kind: 'phone',         needles: ['phone', 'mobile', 'msisdn', 'contact_no', 'contact no'] },
  { kind: 'email',         needles: ['email', 'e_mail', 'e-mail'] },
  { kind: 'ip_address',    needles: ['ip address', 'ip_address', 'ipaddress', 'ip addr'] },
  { kind: 'merchant_name', needles: [
    'merchant_name', 'merchant name', 'business_name', 'business name',
    'legal_name', 'legal name', 'store_name', 'store name',
    'company_name', 'company name',
  ]},
  { kind: 'person_name',   needles: [
    'payer_name', 'payer name', 'payee_name', 'payee name',
    'customer_name', 'sender_name', 'receiver_name', 'beneficiary_name', 'remitter',
    'payer a/c name', 'payee a/c name',          // YES bank columns
  ]},
  { kind: 'account_no',    needles: [
    'account_no', 'account number', 'account_number',
    'acc_no', 'acc no', 'acct_no', 'acctno', 'cod_acct',
    'a/c no', 'a/c no.', 'a/c number',           // YES bank shorthand
    'beneficiary_account', 'beneficiary account',
    'source_account', 'dest_account',
  ]},
  { kind: 'identity_id',   needles: ['pan', 'aadhaar', 'aadhar', 'gstin', 'ifsc'] },
  { kind: 'address',       needles: ['address', 'city', 'pincode', 'pin_code', 'device location', 'device_location'] },
  { kind: 'narration',     needles: ['narration', 'description', 'particulars', 'remarks', 'comment', 'note'] },
];

/** Tokenise: 'Payer Virtual Address' → ['payer', 'virtual', 'address'].
 *  Splits on any non-alphanumeric so 'A/c No.' → ['a', 'c', 'no']. */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** True iff `needle` appears as a contiguous token subsequence inside `haystack`.
 *  Avoids the substring trap where 'dr' (from DR/CR keep needle) would falsely
 *  match the 'dr' inside 'addr'ess, or 'date' would match inside 'consoli date d'. */
function tokensContain(haystack: string[], needle: string): boolean {
  const n = tokenize(needle);
  if (n.length === 0 || haystack.length < n.length) return false;
  outer: for (let i = 0; i <= haystack.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/** Tokens that strongly indicate the column contains PII somewhere in its name. */
const PII_SIGNAL_TOKENS = new Set([
  'vpa', 'upi', 'virtual',
  'name',
  'phone', 'mobile', 'msisdn',
  'email',
  'address', 'pincode',
  'pan', 'aadhaar', 'aadhar', 'gstin', 'ifsc',
  'account', 'a',  // 'a' is for "A/c No." → tokens ['payer','a','c','no'] — combined with 'no' it's clearly PII
]);

function classify(columnName: string): MaskKind {
  const tokens = tokenize(columnName);
  if (tokens.length === 0) return 'unknown';
  // Plain "name" by itself is ambiguous — treat as person_name; merchant_name is matched below.
  if (tokens.length === 1 && tokens[0] === 'name') return 'person_name';

  // Composite-key heuristic: finance teams sometimes build VLOOKUP-helper columns
  // whose name concatenates 3+ real columns (e.g. "Customer Ref No.Transaction AmountPayer Virtual Address").
  // The value contains PII inline — treat as narration so we in-line scrub it.
  if (tokens.length >= 5 && tokens.some(t => PII_SIGNAL_TOKENS.has(t))) {
    return 'narration';
  }

  for (const { kind, needles } of COLUMN_RULES) {
    if (needles.some(n => tokensContain(tokens, n))) return kind;
  }
  return 'unknown';
}

// ─── Value maskers ───────────────────────────────────────────────────────────

function maskVpa(v: string): string {
  if (!v) return v;
  const m = v.match(/^([^\s@]+)@([a-zA-Z]+)$/);
  if (!m) return `user_${shortHash(v)}@masked`;
  return `user_${shortHash(m[1])}@${m[2]}`; // preserve bank handle (@ybl, @okhdfc) so per-bank routing rules can be tested
}

function maskPhone(v: string): string {
  if (!v) return v;
  const digits = v.replace(/\D/g, '');
  const last4 = digits.slice(-4) || shortHash(v, 4);
  return `91XXXXX${last4.padStart(4, 'X')}`;
}

function maskEmail(v: string): string {
  if (!v) return v;
  return `user_${shortHash(v)}@example.test`;
}

function maskPerson(v: string): string {
  if (!v) return v;
  return `Customer ${shortHash(v, 6)}`;
}

function maskMerchant(v: string): string {
  if (!v) return v;
  return `Merchant ${shortHash(v, 6)}`;
}

function maskAccountNo(v: string): string {
  if (!v) return v;
  const digits = v.replace(/\D/g, '');
  if (digits.length < 4) return `XXXX${shortHash(v, 4)}`;
  return `XXXXXXXX${digits.slice(-4)}`;
}

function maskIdentityId(v: string): string {
  if (!v) return v;
  return `MASKED-${shortHash(v, 8).toUpperCase()}`;
}

function maskAddress(_v: string): string {
  return '[masked]';
}

function maskIp(v: string): string {
  if (!v) return v;
  return `10.x.x.${shortHash(v, 3)}`;
}

// No left word-boundary on VPA: composite-key columns (e.g. YES bank's
// `pg_txn_ref_numamountpayer_vpa`) concatenate digits and the VPA without a
// separator. We accept a slightly-wider grab so the VPA local-part is always scrubbed.
const VPA_RE = /([A-Za-z0-9._-]+)@([A-Za-z]{2,})\b/g;
const PHONE_RE = /\b(?:\+?91[- ]?)?[6-9]\d{9}\b/g;
const LONG_DIGITS_RE = /\b\d{10,18}\b/g; // probable account numbers
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function maskNarration(v: string): string {
  if (!v) return v;
  return v
    .replace(EMAIL_RE, m => maskEmail(m))
    .replace(VPA_RE, (_full, name, bank) => `user_${shortHash(name)}@${bank}`)
    .replace(PHONE_RE, m => maskPhone(m))
    .replace(LONG_DIGITS_RE, m => `XXXXXXXX${m.slice(-4)}`);
}

function maskValue(kind: MaskKind, value: string): string {
  switch (kind) {
    case 'keep':          return value;
    case 'vpa':           return maskVpa(value);
    case 'phone':         return maskPhone(value);
    case 'email':         return maskEmail(value);
    case 'person_name':   return maskPerson(value);
    case 'merchant_name': return maskMerchant(value);
    case 'account_no':    return maskAccountNo(value);
    case 'identity_id':   return maskIdentityId(value);
    case 'address':       return maskAddress(value);
    case 'ip_address':    return maskIp(value);
    case 'narration':     return maskNarration(value);
    case 'unknown':       return value;
  }
}

// ─── CSV parser (RFC 4180-ish: handles quoted fields, escaped quotes) ────────

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

/** Read all lines, joining lines that have an unclosed quote (multi-line cells). */
function readCsvRows(body: string): string[][] {
  const rows: string[][] = [];
  // Strip BOM
  if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1);
  const rawLines = body.split(/\r?\n/);
  let buffer = '';
  for (const line of rawLines) {
    buffer = buffer ? buffer + '\n' + line : line;
    // Count unescaped quotes; even = balanced
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

function csvEscape(v: string): string {
  if (v == null) return '';
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowsToCsv(rows: string[][]): string {
  return rows.map(r => r.map(csvEscape).join(',')).join('\n') + '\n';
}

// ─── Main loop ───────────────────────────────────────────────────────────────

interface FileReport {
  file: string;
  rows: number;
  columns: Array<{ name: string; kind: MaskKind }>;
}

const report: FileReport[] = [];

const entries = readdirSync(inputDir)
  .filter(name => statSync(join(inputDir, name)).isFile() && extname(name).toLowerCase() === '.csv');

if (entries.length === 0) {
  console.error(`No .csv files in ${inputDir}. (XLSX not supported — convert with:`);
  console.error(`  soffice --headless --convert-to csv --outdir ${inputDir} <file.xlsx>  )`);
  process.exit(1);
}

for (const name of entries) {
  const inPath = join(inputDir, name);
  const outPath = join(outputDir, name);

  const body = readFileSync(inPath, 'utf-8');
  const rows = readCsvRows(body);
  if (rows.length === 0) {
    console.warn(`[mask] ${name} is empty, skipping`);
    continue;
  }

  const headers = rows[0];
  const classifications: MaskKind[] = headers.map(classify);

  const maskedRows: string[][] = [headers];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    // Pad row to header length if short (some statements have trailing summary lines)
    while (row.length < headers.length) row.push('');
    const masked = row.map((value, i) => maskValue(classifications[i], value ?? ''));
    maskedRows.push(masked);
  }

  writeFileSync(outPath, rowsToCsv(maskedRows));
  report.push({
    file: name,
    rows: maskedRows.length - 1,
    columns: headers.map((h, i) => ({ name: h, kind: classifications[i] })),
  });

  const touched = classifications.filter(k => k !== 'keep' && k !== 'unknown').length;
  console.log(`[mask] ${name}: ${maskedRows.length - 1} rows, ${touched}/${headers.length} columns masked → ${outPath}`);
}

// ─── Report ──────────────────────────────────────────────────────────────────

const reportLines: string[] = [];
reportLines.push('Reco PII Masking Report');
reportLines.push('=======================');
reportLines.push(`Input  : ${inputDir}`);
reportLines.push(`Output : ${outputDir}`);
reportLines.push(`Salt   : ${saltPath}   (KEEP LOCAL — required to reproduce pseudo-IDs)`);
reportLines.push(`Time   : ${new Date().toISOString()}`);
reportLines.push('');

for (const f of report) {
  reportLines.push(`── ${f.file} — ${f.rows} rows`);
  for (const c of f.columns) {
    const tag = c.kind === 'keep' ? 'KEEP' : c.kind === 'unknown' ? 'PASS-THROUGH (unknown)' : `MASK as ${c.kind}`;
    reportLines.push(`   ${c.name.padEnd(32)} ${tag}`);
  }
  const unknowns = f.columns.filter(c => c.kind === 'unknown');
  if (unknowns.length) {
    reportLines.push(`   ⚠ ${unknowns.length} column(s) passed through unchanged — review whether any contain PII:`);
    for (const c of unknowns) reportLines.push(`     • ${c.name}`);
  }
  reportLines.push('');
}

reportLines.push('Next steps:');
reportLines.push('  1) Open _mask-report.txt and check the PASS-THROUGH columns. If any are PII, add a needle');
reportLines.push('     to COLUMN_RULES in scripts/mask-reco-pii.ts and re-run.');
reportLines.push('  2) Spot-check 2–3 rows per file to confirm UTRs / amounts are intact and PII is gone.');
reportLines.push('  3) Share the contents of the output dir (NOT the salt file).');

const reportPath = join(outputDir, '_mask-report.txt');
writeFileSync(reportPath, reportLines.join('\n'));
console.log(`\n[mask] Report written to ${reportPath}`);
console.log(`[mask] ${report.length} file(s) masked. Review the report before sharing.`);
