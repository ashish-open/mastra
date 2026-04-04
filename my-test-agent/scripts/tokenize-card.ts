/**
 * One-time script to tokenize test cards via Wibmo TokenHub /tokenize API.
 *
 * Usage:
 *   npx tsx scripts/tokenize-card.ts
 *
 * This uses your HDFC UAT credentials from .env to tokenize the test cards
 * from the Tokenization_UAT spreadsheet. The resulting tokenReferenceIds
 * are what the agent uses in the /transact call.
 *
 * Run this ONCE, then paste the tokenReferenceIds into wibmo-transact-tool.ts
 */

import { createHmac, createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env manually (no dotenv dependency needed)
function loadEnv(filepath: string) {
  try {
    const content = readFileSync(filepath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch { /* .env not found, rely on system env */ }
}

loadEnv(resolve(import.meta.dirname ?? '.', '..', '.env'));

// ── Config from .env ──────────────────────────────────────────────
const WIBMO = {
  baseUrl: 'https://cardvault-azure.pc.enstage-sas.com',
  vaultId: process.env.WIBMO_VAULT_ID ?? '100001',
  clientId: process.env.WIBMO_CLIENT_ID!,
  clientApiUser: process.env.WIBMO_CLIENT_API_USER!,
  clientApiKey: process.env.WIBMO_CLIENT_API_KEY!,
  tokenSecretKey: process.env.WIBMO_TOKEN_SECRET_KEY!,
  // detokenKey from the Tokenization_UAT spreadsheet (note: may have leading space in spreadsheet)
  detokenKey: (process.env.WIBMO_DETOKEN_KEY ?? '9c881b46-6147-4586-86c8-6875e7e6fd63').trim(),
  merchantId: process.env.WIBMO_MERCHANT_ID ?? 'hdfctestmid1',
};

// ── Test cards from Tokenization_UAT cred spreadsheet ─────────────
const TEST_CARDS = [
  {
    label: 'VISA',
    pan: '4895370075168606',       // X=4
    expiryMonth: '12',
    expiryYear: '2024',
    cardType: 'V',
  },
  {
    label: 'MasterCard',
    pan: '5069004800000008',       // X=5
    expiryMonth: '09',
    expiryYear: '2024',
    cardType: 'M',
  },
  {
    label: 'MasterCard-2',
    pan: '5069005000000004',       // X=5
    expiryMonth: '10',
    expiryYear: '2024',
    cardType: 'M',
  },
];

// ── Auth Token Generation ─────────────────────────────────────────
// From Areion spec: digest = timestamp|vaultId|clientId|apiUser|apiKey
// HMAC-SHA256 with tokenSecretKey, output as uppercase hex
// Format: wtv1:<timestamp>:<hash>
function buildAuthToken(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const data = `${timestamp}|${WIBMO.vaultId}|${WIBMO.clientId}|${WIBMO.clientApiUser}|${WIBMO.clientApiKey}`;

  const hash = createHmac('sha256', WIBMO.tokenSecretKey)
    .update(data, 'utf8')
    .digest('hex')
    .toUpperCase();

  return `wtv1:${timestamp}:${hash}`;
}

// ── Encryption strategies ─────────────────────────────────────────
// KEY FINDING from PDF sample request: encryptedData is BASE64, not hex!
//   Sample shows: "ZGy4aU2DVE/dMRF...ehg==" (base64 with + / and == padding)
//   Java code says: Hex.encodeHex — but the live sample proves base64 is correct.
//
// IV handling from Java sample:
//   String iv = "8d3e5e6436d3b0ef2bd61424c82ab7e3"; // hex string
//   byte[] IV = iv.getBytes();  // → UTF-8 bytes of hex string = 32 bytes as GCM nonce
//   Sent in request as the hex string itself.

type EncryptResult = { encryptedData: string; iv: string; strategyName: string };

function tryAllEncryptStrategies(cardData: object): EncryptResult[] {
  const plaintext = JSON.stringify(cardData);
  const results: EncryptResult[] = [];

  // Key: strip UUID dashes → 32 UTF-8 bytes = AES-256
  const keyString = WIBMO.tokenSecretKey.replace(/-/g, '');
  const keyUtf8 = Buffer.from(keyString, 'utf8');   // 32 bytes
  const keyHexDecoded = Buffer.from(keyString, 'hex'); // 16 bytes

  const ivRaw = randomBytes(16);
  const ivHex = ivRaw.toString('hex'); // 32-char hex string (sent as `iv` field)

  // Helper: build encrypted buffer (ciphertext + GCM auth tag)
  function gcmEncrypt(algo: string, key: Buffer, nonce: Buffer): Buffer {
    const c = createCipheriv(algo, key, nonce, { authTagLength: 16 });
    return Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  }

  // === Strategy A (PRIMARY): AES-256-GCM, key=UTF8(stripped), nonce=UTF8(ivHex)=32 bytes, output=BASE64 ===
  // Matches Java: secretKey.getBytes() for key, iv.getBytes() for nonce, base64 output confirmed by sample
  try {
    const nonce = Buffer.from(ivHex, 'utf8'); // 32 bytes
    const enc = gcmEncrypt('aes-256-gcm', keyUtf8, nonce);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'A: GCM-256 + UTF8-key + hexStringBytes-nonce + BASE64 output' });
  } catch (e: any) { console.log(`  Strategy A failed: ${e.message}`); }

  // === Strategy B: Same as A but raw 16-byte nonce ===
  try {
    const enc = gcmEncrypt('aes-256-gcm', keyUtf8, ivRaw);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'B: GCM-256 + UTF8-key + raw16-nonce + BASE64 output' });
  } catch (e: any) { console.log(`  Strategy B failed: ${e.message}`); }

  // === Strategy C: AES-128-GCM, key=hexDecoded(stripped)=16 bytes, nonce=UTF8(ivHex)=32 bytes ===
  try {
    const nonce = Buffer.from(ivHex, 'utf8');
    const enc = gcmEncrypt('aes-128-gcm', keyHexDecoded, nonce);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'C: GCM-128 + hexDecode-key + hexStringBytes-nonce + BASE64 output' });
  } catch (e: any) { console.log(`  Strategy C failed: ${e.message}`); }

  // === Strategy D: AES-128-GCM, key=hexDecoded, nonce=raw 16 bytes ===
  try {
    const enc = gcmEncrypt('aes-128-gcm', keyHexDecoded, ivRaw);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'D: GCM-128 + hexDecode-key + raw16-nonce + BASE64 output' });
  } catch (e: any) { console.log(`  Strategy D failed: ${e.message}`); }

  // === Strategy E: AES-256-GCM, key=UTF8(stripped), nonce=12 bytes (standard GCM) ===
  try {
    const iv12 = ivRaw.subarray(0, 12);
    const enc = gcmEncrypt('aes-256-gcm', keyUtf8, iv12);
    results.push({ encryptedData: enc.toString('base64'), iv: iv12.toString('hex'), strategyName: 'E: GCM-256 + UTF8-key + 12byte-nonce + BASE64 output' });
  } catch (e: any) { console.log(`  Strategy E failed: ${e.message}`); }

  // === Strategy F: key=first 32 bytes of full UUID (with dashes), nonce=UTF8(ivHex) ===
  try {
    const keyFull = Buffer.from(WIBMO.tokenSecretKey, 'utf8').subarray(0, 32);
    const nonce = Buffer.from(ivHex, 'utf8');
    const enc = gcmEncrypt('aes-256-gcm', keyFull, nonce);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'F: GCM-256 + UTF8-key-with-dashes-trunc32 + hexStringBytes-nonce + BASE64' });
  } catch (e: any) { console.log(`  Strategy F failed: ${e.message}`); }

  // === Strategy G: detokenKey (stripped dashes) AES-256-GCM + UTF8 nonce ===
  // Maybe detokenKey is the encryption key, not tokenSecretKey
  try {
    const dk = Buffer.from(WIBMO.detokenKey.replace(/-/g, ''), 'utf8');
    const nonce = Buffer.from(ivHex, 'utf8');
    const enc = gcmEncrypt('aes-256-gcm', dk, nonce);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'G: GCM-256 + detokenKey-UTF8 + hexStringBytes-nonce + BASE64' });
  } catch (e: any) { console.log(`  Strategy G failed: ${e.message}`); }

  // === Strategy H: detokenKey AES-256-GCM + raw 16-byte nonce ===
  try {
    const dk = Buffer.from(WIBMO.detokenKey.replace(/-/g, ''), 'utf8');
    const enc = gcmEncrypt('aes-256-gcm', dk, ivRaw);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'H: GCM-256 + detokenKey-UTF8 + raw16-nonce + BASE64' });
  } catch (e: any) { console.log(`  Strategy H failed: ${e.message}`); }

  // === Strategy I: AES-256-CBC + UTF8-key + BASE64 output ===
  try {
    const c = createCipheriv('aes-256-cbc', keyUtf8, ivRaw);
    const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'I: CBC-256 + UTF8-key + raw16-IV + BASE64 output' });
  } catch (e: any) { console.log(`  Strategy I failed: ${e.message}`); }

  // === Strategy J: AES-128-CBC + hexDecode-key + BASE64 output ===
  try {
    const c = createCipheriv('aes-128-cbc', keyHexDecoded, ivRaw);
    const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    results.push({ encryptedData: enc.toString('base64'), iv: ivHex, strategyName: 'J: CBC-128 + hexDecode-key + raw16-IV + BASE64 output' });
  } catch (e: any) { console.log(`  Strategy J failed: ${e.message}`); }

  return results;
}

// Default encryption — Strategy A (matches Java sample + base64 output from PDF sample request)
function encryptCardData(cardData: object): { encryptedData: string; iv: string } {
  const plaintext = JSON.stringify(cardData);
  const keyString = WIBMO.tokenSecretKey.replace(/-/g, '');
  const key = Buffer.from(keyString, 'utf8');   // 32 UTF-8 bytes = AES-256
  const ivRaw = randomBytes(16);
  const ivHex = ivRaw.toString('hex');          // sent as `iv` field
  const gcmNonce = Buffer.from(ivHex, 'utf8');  // 32 bytes, matches Java iv.getBytes()

  const cipher = createCipheriv('aes-256-gcm', key, gcmNonce, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);

  return {
    encryptedData: encrypted.toString('base64'), // BASE64 — confirmed by PDF sample request
    iv: ivHex,
  };
}

// ── Call Wibmo /tokenize with a specific encryptedData+iv ────────
async function callTokenize(
  card: (typeof TEST_CARDS)[0],
  encryptedData: string,
  iv: string,
  strategyName: string,
) {
  const xAuthToken = buildAuthToken();
  const clientReferenceId = `tokenize-${card.label}-${Date.now()}`;

  const now = new Date();
  const userConsentTimestamp = [
    String(now.getDate()).padStart(2, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    now.getFullYear(),
  ].join('/') + ' ' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');

  const requestBody: Record<string, string> = {
    encryptedData,
    iv,
    clientReferenceId,
    merchantId: WIBMO.merchantId,
    cardType: card.cardType,
    userConsent: 'Y',
    userConsentTimestamp,
    var1: 'Y', // AFA done — mandatory for COFT Visa
  };

  const response = await fetch(
    `${WIBMO.baseUrl}/tokenVault/v3/tokenize`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        clientApiUser: WIBMO.clientApiUser,
        clientApiKey: WIBMO.clientApiKey,
        'X-Auth-Token': xAuthToken,
        clientId: WIBMO.clientId,
      },
      body: JSON.stringify(requestBody),
    },
  );

  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { return null; }
  return data;
}

// ── Tokenize a card (tries all strategies until one succeeds) ─────
async function tokenizeCard(card: (typeof TEST_CARDS)[0]) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Tokenizing: ${card.label} (${card.pan.slice(0, 6)}...${card.pan.slice(-4)})`);
  console.log(`Merchant ID: ${WIBMO.merchantId}`);

  const cardData = {
    pan: card.pan,
    expiryMonth: card.expiryMonth,
    expiryYear: card.expiryYear,
    email: 'test@agenticpay.com',
  };

  const strategies = tryAllEncryptStrategies(cardData);
  console.log(`Trying ${strategies.length} encryption strategies...`);

  for (const s of strategies) {
    process.stdout.write(`  [${s.strategyName}] → `);
    try {
      const data = await callTokenize(card, s.encryptedData, s.iv, s.strategyName);
      if (!data) { console.log('parse error'); continue; }

      if (data.statusCode === 'TK0000') {
        console.log(`✅ SUCCESS!`);
        console.log(`\n🎉 WORKING STRATEGY: ${s.strategyName}`);
        console.log(`   tokenReferenceId: ${data.tokenReferenceId}`);
        console.log(`   tokenStatus: ${data.tokenStatus}`);
        console.log(`   tokenLast4: ${data.tokenLast4}`);
        console.log(`   tokenExpiryDate: ${data.tokenExpiryDate}`);
        console.log(`   panLast4: ${data.panLast4}`);
        console.log(`   provider: ${data.provider}`);
        if (data.encTokenInfo) console.log(`   encTokenInfo: ${data.encTokenInfo}`);
        return {
          label: card.label,
          cardType: card.cardType,
          tokenReferenceId: data.tokenReferenceId,
          tokenLast4: data.tokenLast4,
          tokenStatus: data.tokenStatus,
          panLast4: data.panLast4,
          provider: data.provider,
          workingStrategy: s.strategyName,
        };
      } else {
        console.log(`❌ ${data.statusCode}: ${data.errorDesc ?? data.msg}`);
      }
    } catch (err: any) {
      console.log(`network error: ${err.message}`);
    }
  }

  console.log(`\n❌ All strategies failed for ${card.label}`);
  return null;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('Wibmo COFT Tokenization Script');
  console.log('==============================');
  console.log(`Vault ID: ${WIBMO.vaultId}`);
  console.log(`Client ID: ${WIBMO.clientId}`);
  console.log(`API User: ${WIBMO.clientApiUser}`);
  console.log(`Merchant ID: ${WIBMO.merchantId}`);
  console.log(`Token Secret Key: ${WIBMO.tokenSecretKey.slice(0, 8)}...`);

  // Validate env
  const missing = ['clientId', 'clientApiUser', 'clientApiKey', 'tokenSecretKey'] as const;
  for (const key of missing) {
    if (!WIBMO[key]) {
      console.error(`\n❌ Missing env var: WIBMO_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`);
      process.exit(1);
    }
  }

  const results = [];
  for (const card of TEST_CARDS) {
    const result = await tokenizeCard(card);
    if (result) results.push(result);
  }

  if (results.length > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`\n✅ SUCCESSFUL TOKENIZATIONS — paste these into wibmo-transact-tool.ts:\n`);
    console.log(`const UAT_TOKEN_CARDS: Record<string, TokenCard> = {`);
    for (const r of results) {
      const key = `${r.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
      console.log(`  '${key}': {`);
      console.log(`    tokenReferenceId: '${r.tokenReferenceId}',`);
      console.log(`    tokenPan: '', // Will be in encTokenInfo — decrypt with detokenKey`);
      console.log(`    cardType: '${r.cardType}',`);
      console.log(`    last4: '${r.panLast4 ?? r.tokenLast4}',`);
      console.log(`    trMerchantId: '${WIBMO.merchantId}',`);
      console.log(`  },`);
    }
    console.log(`};`);
  }

  console.log(`\nDone. ${results.length}/${TEST_CARDS.length} cards tokenized successfully.`);
}

main().catch(console.error);
