/**
 * Reconciliation file-upload endpoint.
 *
 *   POST /reco/upload
 *
 * Body: multipart/form-data with fields
 *   file       — the CSV/XLSX/PDF to parse
 *   adapterId  — which adapter parses the file (e.g. 'bank' | 'swiggy')
 *   accountId  — adapter-specific account label ('axis' | 'hdfc' | restaurant id)
 *   date       — YYYY-MM-DD the statement applies to
 *
 * Behavior:
 *   1. Validates the adapter exists and supports parseFile().
 *   2. Parses the uploaded file → NormalizedTxn[]
 *   3. Returns the parsed rows so the caller can inspect / spot-check.
 *
 * NOTE: this endpoint deliberately does NOT trigger the workflow itself —
 * the caller should review the parsed rows first, then invoke
 * reconcileWorkflow with the same date/configId. We can wire a one-shot
 * "parse + run" path once the demo proves the parse step.
 */

import type { ApiRoute } from '@mastra/core/server';
import { ensureConfigsRegistered, RECO_CONFIGS_LOADED } from '../reconciliation/configs.js';
import { getAdapter } from '../reconciliation/adapter.js';
void RECO_CONFIGS_LOADED;
ensureConfigsRegistered();

export const recoUploadRoute: ApiRoute = {
  path: '/reco/upload',
  method: 'POST',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: any) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch (e) {
      return c.json({ error: 'Expected multipart/form-data body' }, 400);
    }

    const adapterId = String(form.get('adapterId') ?? '');
    const accountId = String(form.get('accountId') ?? '');
    const date = String(form.get('date') ?? '');
    const file = form.get('file') as File | null;

    if (!adapterId) return c.json({ error: "missing 'adapterId'" }, 400);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: "missing or invalid 'date' (YYYY-MM-DD)" }, 400);
    }
    if (!file) return c.json({ error: "missing 'file'" }, 400);

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

    return c.json({
      adapterId,
      adapterName: adapter.name,
      date,
      accountId: accountId || null,
      mime,
      count: txns.length,
      txns,
    });
  }),
};
