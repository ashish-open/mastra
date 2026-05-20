/**
 * Reconciliation upload + staging endpoints.
 *
 *   POST /reco/upload
 *     Body: multipart/form-data
 *       file        — CSV / XLSX / PDF to parse
 *       configId    — REQUIRED. Which reco config this upload feeds.
 *       adapterId   — REQUIRED. Which adapter parses the file (e.g. 'pg-razorpay', 'bank').
 *       accountId   — Optional. Adapter-specific account label (bank id, MID, etc.).
 *       date        — REQUIRED. YYYY-MM-DD the statement applies to.
 *
 *     Behavior:
 *       1. Validates adapter exists + supports parseFile().
 *       2. Parses the uploaded file → NormalizedTxn[]
 *       3. PERSISTS those rows to reco_staged_transactions (idempotent upsert
 *          keyed on (configId, adapterId, date)).
 *       4. Returns a preview (first 50 rows) + counts.
 *
 *   GET /reco/staged?configId=…&date=YYYY-MM-DD
 *     Returns which sources have been staged for this (config, date) so the UI
 *     can show "3/4 sources ready — still need: bank".
 *
 *   DELETE /reco/staged?configId=…&adapterId=…&date=…
 *     Admin: wipe one staged slot so a fresh upload can replace it from scratch.
 *
 * After all required sources for a configId are staged, the caller triggers
 * the workflow via `POST /api/workflows/reconcileWorkflow/start-async`. The
 * workflow reads from this staging table.
 */

import type { ApiRoute } from '@mastra/core/server';
import { ensureConfigsRegistered, RECO_CONFIGS_LOADED } from '../reconciliation/configs.js';
import { getAdapter, getConfig } from '../reconciliation/adapter.js';
import {
  stageTransactions,
  listStagedSources,
  clearStagedSlot,
} from '../reconciliation/tools.js';
import type { NormalizedTxn } from '../reconciliation/types.js';
void RECO_CONFIGS_LOADED;
ensureConfigsRegistered();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HonoCtx = any;

export const recoUploadRoute: ApiRoute = {
  path: '/reco/upload',
  method: 'POST',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: HonoCtx) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'Expected multipart/form-data body' }, 400);
    }

    const configId = String(form.get('configId') ?? '').trim();
    const adapterId = String(form.get('adapterId') ?? '').trim();
    const accountId = String(form.get('accountId') ?? '').trim();
    const date = String(form.get('date') ?? '').trim();
    const file = form.get('file') as File | null;

    if (!configId) return c.json({ error: "missing 'configId'" }, 400);
    if (!adapterId) return c.json({ error: "missing 'adapterId'" }, 400);
    if (!DATE_RE.test(date)) return c.json({ error: "missing or invalid 'date' (YYYY-MM-DD)" }, 400);
    if (!file) return c.json({ error: "missing 'file'" }, 400);

    // Validate configId is registered AND adapterId is one of its sources —
    // catches typos that would otherwise stage rows the workflow can never read.
    let config;
    try {
      config = getConfig(configId);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const validAdapter = config.sources.some(s => s.adapterId === adapterId);
    if (!validAdapter) {
      return c.json({
        error: `Adapter '${adapterId}' is not a source of config '${configId}'. ` +
          `Expected one of: [${config.sources.map(s => s.adapterId).join(', ')}]`,
      }, 400);
    }

    let adapter;
    try {
      adapter = getAdapter(adapterId);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (!adapter.parseFile) {
      return c.json({ error: `Adapter '${adapterId}' does not support file upload` }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = file.type || 'application/octet-stream';
    let txns;
    try {
      txns = await adapter.parseFile(buffer, mime, { date, accountId });
    } catch (e) {
      return c.json({ error: `Parse failed: ${(e as Error).message}` }, 400);
    }

    if (!Array.isArray(txns) || txns.length === 0) {
      return c.json({
        error: `Parsed 0 transactions from '${file.name}'. Check the file format ` +
          `matches what '${adapter.name}' expects.`,
      }, 400);
    }

    let stageResult;
    try {
      stageResult = await stageTransactions({
        configId,
        adapterId,
        date,
        txns,
        filename: file.name,
      });
    } catch (e) {
      return c.json({ error: `Stage write failed: ${(e as Error).message}` }, 500);
    }

    // Tell the UI what's still missing for this config/date so they know
    // whether they can start the run yet.
    const staged = await listStagedSources(configId, date);
    const stagedAdapterIds = new Set(staged.map(s => s.adapterId));
    const missingAdapters = config.sources
      .map(s => s.adapterId)
      .filter(id => !stagedAdapterIds.has(id));

    return c.json({
      adapterId,
      adapterName: adapter.name,
      configId,
      date,
      accountId: accountId || null,
      mime,
      filename: file.name,
      count: txns.length,
      replacedPrior: stageResult.replaced,
      txns: txns.slice(0, 50),               // preview only
      truncatedPreview: txns.length > 50,
      stagedSources: staged.map(s => ({
        adapterId: s.adapterId,
        count: s.count,
        uploadedAt: s.uploadedAt,
        filename: s.filename,
      })),
      missingAdapters,
      readyToRun: missingAdapters.length === 0,
    });
  }),
};

// ─── GET /reco/staged?configId=…&date=… ─────────────────────────────────────
//
// UI poll: which sources are ready for a given (config, date)?

export const recoStagedListRoute: ApiRoute = {
  path: '/reco/staged',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: HonoCtx) => {
    const configId = String(c.req.query('configId') ?? '').trim();
    const date = String(c.req.query('date') ?? '').trim();
    if (!configId) return c.json({ error: "missing 'configId'" }, 400);
    if (!DATE_RE.test(date)) return c.json({ error: "missing or invalid 'date' (YYYY-MM-DD)" }, 400);

    let config;
    try {
      config = getConfig(configId);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    const staged = await listStagedSources(configId, date);
    const stagedMap = new Map(staged.map(s => [s.adapterId, s]));

    return c.json({
      configId,
      date,
      sources: config.sources.map(s => {
        const st = stagedMap.get(s.adapterId);
        // canFetch surfaces whether the adapter has a real API/MCP integration
        // so the UI can show a "Fetch from API" button next to it. Adapters
        // that are upload-only (bank, marketplaces, ERP) have no fetch().
        let canFetch = false;
        try { canFetch = !!getAdapter(s.adapterId).fetch; } catch { /* registered? */ }
        return {
          adapterId: s.adapterId,
          accountId: s.accountId ?? null,
          staged: !!st,
          count: st?.count ?? 0,
          uploadedAt: st?.uploadedAt ?? null,
          filename: st?.filename ?? null,
          canFetch,
        };
      }),
      // A source is "ready" if it has staged data OR can be fetched live.
      // Either way the workflow can populate it at run time.
      readyToRun: config.sources.every(s => {
        if (stagedMap.has(s.adapterId)) return true;
        try { return !!getAdapter(s.adapterId).fetch; } catch { return false; }
      }),
    });
  }),
};

// ─── POST /reco/fetch — fetch a source live + stage it ──────────────────────
//
// Body (JSON): { configId, date, adapterId }
// For sources whose adapter has fetch() (MCP/REST/DB), this calls fetch() and
// stages the result. The reconciliation can then run against this data.
// Uploads still work in parallel — they're stored under the same staging slot
// with replace-semantics.

export const recoFetchRoute: ApiRoute = {
  path: '/reco/fetch',
  method: 'POST',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: HonoCtx) => {
    let body: { configId?: string; date?: string; adapterId?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }

    const configId = String(body.configId ?? '').trim();
    const adapterId = String(body.adapterId ?? '').trim();
    const date = String(body.date ?? '').trim();
    if (!configId) return c.json({ error: "missing 'configId'" }, 400);
    if (!adapterId) return c.json({ error: "missing 'adapterId'" }, 400);
    if (!DATE_RE.test(date)) return c.json({ error: "missing or invalid 'date' (YYYY-MM-DD)" }, 400);

    let config;
    try { config = getConfig(configId); } catch (e) { return c.json({ error: (e as Error).message }, 400); }

    // The source must be declared by this config — otherwise we'd stage rows
    // the workflow can never read.
    const sourceDecl = config.sources.find(s => s.adapterId === adapterId);
    if (!sourceDecl) {
      return c.json({
        error: `Adapter '${adapterId}' is not a source of config '${configId}'. ` +
          `Expected one of: [${config.sources.map(s => s.adapterId).join(', ')}]`,
      }, 400);
    }

    let adapter;
    try { adapter = getAdapter(adapterId); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
    if (!adapter.fetch) {
      return c.json({
        error: `Adapter '${adapterId}' has no fetch() — only upload is supported for this source.`,
      }, 400);
    }

    let txns: NormalizedTxn[];
    try {
      txns = await adapter.fetch({
        date,
        accountId: sourceDecl.accountId,
        options: sourceDecl.options,
      });
    } catch (e) {
      // Auth/network/API errors land here. Bubble up with a clear message
      // so the UI can show it next to the source.
      return c.json({ error: `Fetch failed: ${(e as Error).message}` }, 502);
    }

    if (!Array.isArray(txns) || txns.length === 0) {
      return c.json({
        ok: true,
        configId, adapterId, date,
        count: 0,
        message: 'Adapter returned 0 rows — possibly no settlements for this date.',
      });
    }

    const stageResult = await stageTransactions({
      configId, adapterId, date, txns,
      filename: `[api-fetch:${adapterId}:${new Date().toISOString()}]`,
    });

    const staged = await listStagedSources(configId, date);
    const stagedAdapterIds = new Set(staged.map(s => s.adapterId));
    const missingAdapters = config.sources.map(s => s.adapterId).filter(id => !stagedAdapterIds.has(id));

    return c.json({
      ok: true,
      configId, adapterId, date,
      adapterName: adapter.name,
      count: stageResult.count,
      replacedPrior: stageResult.replaced,
      previewTxns: txns.slice(0, 50),
      truncatedPreview: txns.length > 50,
      stagedSources: staged.map(s => ({
        adapterId: s.adapterId,
        count: s.count,
        uploadedAt: s.uploadedAt,
        filename: s.filename,
      })),
      missingAdapters,
      readyToRun: missingAdapters.length === 0,
    });
  }),
};

// ─── DELETE /reco/staged?configId=…&adapterId=…&date=… ──────────────────────
//
// Admin: wipe one slot. Useful when an upload had bad data and the user wants
// to start fresh.

export const recoStagedDeleteRoute: ApiRoute = {
  path: '/reco/staged',
  method: 'DELETE',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: HonoCtx) => {
    const configId = String(c.req.query('configId') ?? '').trim();
    const adapterId = String(c.req.query('adapterId') ?? '').trim();
    const date = String(c.req.query('date') ?? '').trim();
    if (!configId || !adapterId || !DATE_RE.test(date)) {
      return c.json({ error: "missing or invalid 'configId' / 'adapterId' / 'date'" }, 400);
    }
    const r = await clearStagedSlot(configId, adapterId, date);
    return c.json({ configId, adapterId, date, deleted: r.deleted });
  }),
};
