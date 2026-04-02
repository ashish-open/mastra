# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

IMPORTANT: Read and follow all instructions in @AGENTS.md before starting any task.
Read the package-local `AGENTS.md` (e.g., `packages/core/AGENTS.md`) before modifying any package.

## Quick reference

### Build a single package (preferred)

```bash
pnpm build:core                              # packages/core
pnpm build:memory                            # packages/memory
pnpm --filter ./packages/<name> build        # any package by path
```

### Test a single package

```bash
pnpm test:core                               # packages/core
pnpm test:memory                             # packages/memory
pnpm --filter ./packages/<name> test         # any package by path
```

Run a single test file from the package directory:

```bash
cd packages/core && pnpm vitest run src/agent/agent.test.ts
```

### Lint and typecheck

```bash
pnpm --filter ./packages/<name> typecheck    # single package
pnpm typecheck                               # entire workspace (slow)
pnpm prettier:format                         # format all files
pnpm prettier:changed                        # format only changed files
```

### Changesets

Run once per logical change group — avoid one changeset spanning many unrelated packages:

```bash
pnpm changeset -s -m "Added X feature" --minor @mastra/core
pnpm changeset -s -m "Fixed Y bug" --patch @mastra/memory
```

See `.mastracode/commands/changeset.md` for message guidelines and multi-package rules.

### Integration tests

```bash
pnpm dev:services:up                         # start Docker services (Postgres, etc.)
pnpm --filter ./packages/<name> test:integration
pnpm dev:services:down                       # stop services
```

Some integration-test folders require `pnpm i --ignore-workspace` before running.

## Architecture

Mastra is a TypeScript framework for building AI agents, workflows, and tools. It is a pnpm workspace monorepo orchestrated with Turborepo.

### Package dependency graph (simplified)

```
@mastra/core          ← foundation: agents, tools, workflows, storage, memory interfaces
  ├── @mastra/memory  ← thread-based persistence, semantic recall, working memory
  ├── @mastra/rag     ← retrieval-augmented generation, vector search
  ├── @mastra/mcp     ← Model Context Protocol server/client
  ├── @mastra/evals   ← evaluation framework
  ├── @mastra/server  ← HTTP server (Hono-based)
  ├── mastra (CLI)    ← project scaffolding, dev server, deployment
  └── @mastra/playground-ui ← studio/playground React UI
```

Packages outside `packages/` follow the same pattern:
- `stores/*` — pluggable storage backends (PostgreSQL, LibSQL, etc.)
- `deployers/*` — deployment adapters (Vercel, Cloudflare, Netlify)
- `server-adapters/*` — framework adapters (Hono, Express)
- `voice/*` — voice/speech providers
- `integrations/*` — third-party API integrations
- `auth/*` — authentication providers
- `client-sdks/*` — client libraries (JS, React)

### Core internals (`packages/core/src/`)

- **Mastra class** (`mastra/`) — central DI container; wires agents, tools, workflows, storage
- **Agent** (`agent/`) — LLM interaction with tool use, memory, voice; supports multi-model routing
- **Tools** (`tools/`) — extensive tool system with dynamic composition from multiple sources
- **Workflows** (`workflows/`) — graph-based step execution with `.then()`, `.branch()`, `.parallel()`, suspend/resume
- **Storage** (`storage/`) — pluggable persistence interface
- **A2A** (`a2a/`) — agent-to-agent communication protocol

### Key patterns

- **Subpath exports**: Core uses granular subpath exports (`@mastra/core/storage`, `@mastra/core/workflows/evented`, etc.) — don't import everything from root.
- **Workspace protocol**: Internal deps use `workspace:*` in package.json.
- **Turbo `^build`**: Building one package only builds its direct upstream deps, not the full monorepo.
- **Node >= 22.13.0**: Hard requirement across all packages.
- **Zod v4**: The workspace standardizes on Zod v4 (`^4.3.6`) via pnpm catalog.
- **AI SDK multi-version**: Core supports AI SDK v5 and v6 adapters; changes to LLM routing must validate both.

## Enterprise Edition (EE)

- Code in `ee/` directories is licensed under the Mastra Enterprise License (not Apache-2.0).
- Import via explicit subpath: `@mastra/core/auth/ee`.
- New EE features go in an `ee/` subdirectory within the relevant package.

## Documentation

- Code changes must include related documentation updates when applicable.
- Docs live in `docs/src/content/en/` — follow `docs/AGENTS.md` and styleguides in `docs/styleguides/`.
- New packages require new documentation in `docs/`.
