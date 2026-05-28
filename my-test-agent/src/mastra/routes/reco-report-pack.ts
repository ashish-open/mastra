/**
 * Report-pack HTTP surface.
 *
 *   GET  /integration/reco/runs/:runId/report-pack         — JSON manifest
 *   GET  /integration/reco/runs/:runId/report-pack/file    — single file stream (?path=05_dispositions.csv)
 *
 * The manifest tells OpenArc what files are available and their sizes; the
 * frontend then GETs each file individually to assemble a download bundle.
 * Per-file streaming avoids needing a ZIP library in the runtime.
 *
 * Files are read from disk at $RECO_REPORT_PACK_ROOT/<runId>/. The directory
 * is populated by `buildReportPackStep` at the tail of the reco workflow,
 * and is durable across server restarts.
 *
 * Auth mirrors the rest of /integration/* — Bearer MASTRA_INTEGRATION_TOKEN
 * when set, pass-through in dev mode.
 *
 * Path traversal: the `file` endpoint validates the requested path is a
 * relative path that doesn't escape the run directory, even though the
 * filesystem read uses path.resolve which would catch most attacks.
 */

import type { ApiRoute } from '@mastra/core/server';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as pathResolve, join as pathJoin, relative as pathRelative, sep as pathSep } from 'node:path';
import { readdirSync } from 'node:fs';

const REPORT_PACK_ROOT = process.env.RECO_REPORT_PACK_ROOT ?? './run-reports';

function checkToken(c: { req: { header: (k: string) => string | undefined } }):
  | { ok: true }
  | { ok: false; status: 401; error: string } {
  const required = process.env.MASTRA_INTEGRATION_TOKEN;
  if (!required) return { ok: true };
  const got = c.req.header('authorization') || c.req.header('Authorization');
  if (!got || got !== `Bearer ${required}`) {
    return { ok: false, status: 401, error: 'Missing or invalid Authorization: Bearer <token>' };
  }
  return { ok: true };
}

/** Validate that `runId` is a safe filesystem segment (no `..`, no separators). */
function safeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId);
}

/** Recursively list files under a directory. Returns paths relative to the dir. */
function listFiles(rootAbs: string, dir: string = ''): string[] {
  const out: string[] = [];
  const fullDir = pathJoin(rootAbs, dir);
  for (const ent of readdirSync(fullDir, { withFileTypes: true })) {
    const rel = dir ? `${dir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(rootAbs, rel));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

// ─── GET /integration/reco/runs/:runId/report-pack — manifest ───────────────

export const integrationRecoReportPackManifestRoute: ApiRoute = {
  path: '/integration/reco/runs/:runId/report-pack',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: any) => {
    const auth = checkToken(c);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const runId = c.req.param('runId');
    if (!safeRunId(runId)) return c.json({ error: 'Invalid runId' }, 400);

    const dir = pathResolve(REPORT_PACK_ROOT, runId);
    if (!existsSync(dir)) {
      return c.json({
        runId,
        available: false,
        message: 'Report pack not built (or has been deleted). It is generated automatically at the end of every reco run; re-run the workflow to rebuild.',
        files: [],
      });
    }

    const rels = listFiles(dir).sort();
    const files = rels.map(rel => {
      const abs = pathJoin(dir, rel);
      const stat = statSync(abs);
      return {
        path: rel,
        bytes: stat.size,
        downloadUrl: `/integration/reco/runs/${runId}/report-pack/file?path=${encodeURIComponent(rel)}`,
      };
    });

    return c.json({ runId, available: true, fileCount: files.length, files });
  }),
};

// ─── GET /integration/reco/runs/:runId/report-pack/file — single file ───────

export const integrationRecoReportPackFileRoute: ApiRoute = {
  path: '/integration/reco/runs/:runId/report-pack/file',
  method: 'GET',
  requiresAuth: false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createHandler: (): any => Promise.resolve(async (c: any) => {
    const auth = checkToken(c);
    if (!auth.ok) return c.json({ error: auth.error }, auth.status);

    const runId = c.req.param('runId');
    if (!safeRunId(runId)) return c.json({ error: 'Invalid runId' }, 400);

    const requested = (c.req.query('path') as string | undefined) ?? '';
    if (!requested) return c.json({ error: 'Missing ?path=<file>' }, 400);

    // Allow forward-slash relative paths only — no '..', no absolute, no
    // backslash. Resolve against the run dir and confirm the result stays
    // inside it (belt-and-braces against path traversal).
    if (requested.includes('..') || requested.startsWith('/') || requested.startsWith('\\') || requested.includes(`${pathSep}..`)) {
      return c.json({ error: 'Invalid path' }, 400);
    }
    const dir = pathResolve(REPORT_PACK_ROOT, runId);
    const abs = pathResolve(dir, requested);
    if (!abs.startsWith(dir + pathSep) && abs !== dir) {
      return c.json({ error: 'Path escapes run directory' }, 400);
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return c.json({ error: 'File not found' }, 404);
    }

    const contents = readFileSync(abs, 'utf-8');
    const filename = pathRelative(dir, abs).split(/[\\/]/).pop() ?? 'file.csv';
    const mime = filename.endsWith('.csv') ? 'text/csv' : 'application/octet-stream';

    return new Response(contents, {
      status: 200,
      headers: {
        'Content-Type': `${mime}; charset=utf-8`,
        // Suggest a sensible filename when the user clicks the link directly.
        'Content-Disposition': `attachment; filename="${filename}"`,
        // Disable caching — reco runs are rebuilt routinely.
        'Cache-Control': 'no-store',
      },
    });
  }),
};
