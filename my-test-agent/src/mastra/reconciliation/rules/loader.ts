/**
 * Per-config rule sheets — Plan B#3.
 *
 * Each ReconcileConfig can ship a markdown file at
 *   `src/mastra/reconciliation/rules/<configId>.md`
 *
 * The disposition agent's prompt picks this up at workflow runtime and
 * appends it under "## Config-specific rules", letting ops customize
 * behaviour for a platform without code changes.
 *
 * Why a file (not in-code registry):
 *   - Ops should be able to edit rules without touching TS / restarting
 *     the build pipeline (the next workflow run picks up changes).
 *   - Rules read like a doc; markdown is the right substrate.
 *   - File-per-config gives clean per-platform diffs in git.
 *
 * Caching:
 *   - First read: file → memory → return.
 *   - Subsequent reads: serve from memory.
 *   - To force reload (e.g. after editing during dev), call `clearRuleCache()`
 *     or restart the workflow process.
 *
 * Production note: `mastra build` may not copy `.md` files into
 * `.mastra/output/`. Test before relying on this in a deployed build —
 * if missing, set RECO_RULES_DIR env var to an absolute path on the
 * deployed filesystem.
 */

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Candidate directories searched for `<configId>.md` rule sheets, in order.
 * First one that exists wins. Resolved once at first lookup and cached.
 *
 * Why a list instead of a single path:
 *   - In `pnpm dev`, the loader source lives at
 *       src/mastra/reconciliation/rules/loader.ts
 *     and `import.meta.url` resolves the `.md` files next to it.
 *
 *   - In `mastra build`, the bundler emits `.mastra/output/index.mjs` and
 *     does NOT copy `.md` files — `import.meta.url` then points into the
 *     bundle directory which has no markdown. We fall back to the source
 *     tree relative to process.cwd(), which is what `pnpm start` honours.
 *
 *   - Operators can override with RECO_RULES_DIR for deployments where
 *     rules ship from a separate volume / config repo.
 */
function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.RECO_RULES_DIR) dirs.push(process.env.RECO_RULES_DIR);
  // Co-located with loader.ts (dev mode source tree).
  dirs.push(path.dirname(fileURLToPath(import.meta.url)));
  // Source tree from project root (works for pnpm dev when cwd=root).
  dirs.push(path.resolve(process.cwd(), 'src/mastra/reconciliation/rules'));
  // Source tree from .mastra/output (cwd=src/mastra/public, so go up two).
  dirs.push(path.resolve(process.cwd(), '../reconciliation/rules'));
  return dirs;
}

let resolvedDir: string | null | undefined;

async function resolveRulesDir(): Promise<string | null> {
  if (resolvedDir !== undefined) return resolvedDir;
  for (const d of candidateDirs()) {
    try {
      // Probe for a known marker (the README we ship alongside the rules).
      await access(path.join(d, 'README.md'));
      resolvedDir = d;
      console.log(`[reco-rules] resolved rules dir: ${d}`);
      return d;
    } catch {
      // try next
    }
  }
  console.warn(
    '[reco-rules] no rules directory found in any candidate location — ' +
    `(set RECO_RULES_DIR to override). Searched: ${candidateDirs().join(', ')}`
  );
  resolvedDir = null;
  return null;
}

const cache = new Map<string, string>();

/**
 * Returns the markdown rule sheet for a config id, or an empty string when
 * no sheet exists. Never throws — a missing file is the common, non-error
 * case (most configs won't have overrides).
 */
export async function loadConfigRules(configId: string): Promise<string> {
  if (cache.has(configId)) return cache.get(configId)!;

  // Sanity: refuse path traversal in case configId is ever derived from
  // user input. Today it's only from registered configs, but be safe.
  if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(configId)) {
    cache.set(configId, '');
    return '';
  }

  const dir = await resolveRulesDir();
  if (!dir) {
    cache.set(configId, '');
    return '';
  }

  const filePath = path.join(dir, `${configId}.md`);
  try {
    const md = await readFile(filePath, 'utf8');
    const trimmed = md.trim();
    cache.set(configId, trimmed);
    return trimmed;
  } catch (err) {
    // ENOENT is expected — no sheet = no overrides. Other errors (permission,
    // EISDIR) bubble up as a warning so the operator notices, but we still
    // return empty so the workflow doesn't fail on a missing rule.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[reco-rules] could not load rules for '${configId}': ${(err as Error).message}`);
    }
    cache.set(configId, '');
    return '';
  }
}

/**
 * Synchronous quick-check — useful for logging at workflow start
 * ("loaded N rule sheets") without awaiting each one separately.
 *
 * Returns the cached value or undefined when not yet loaded.
 */
export function peekConfigRules(configId: string): string | undefined {
  return cache.get(configId);
}

/** Drop the cache. Test setup hook, or dev refresh trigger. */
export function clearRuleCache(): void {
  cache.clear();
  resolvedDir = undefined;
}
