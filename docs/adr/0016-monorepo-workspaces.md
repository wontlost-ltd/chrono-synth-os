# 0016 — npm workspaces monorepo over polyrepo

**Status:** Accepted
**Date:** 2025-Q3
**Scope:** repository top-level layout

## Context

Chrono Synth OS ships eight published packages plus the runtime
service:

- `@chrono/kernel` — pure-domain core
- `@chrono/contracts` — wire schemas & kind constants
- `@chrono/data-plane` — storage abstractions
- `@chrono/sync-engine` — replication
- `@chrono/design-tokens` — shared visual tokens
- `@chrono/adapter-web` / `adapter-tauri` / `adapter-react-native`
- `@chrono/kernel-testkit` — test helpers

Each could live in its own repo with semver coupling, but the
pattern of cross-package change ("kernel adds an event kind →
contracts must add the constant → adapter-web must register it")
is constant. Polyrepo would mean three PRs across three repos
linked by manual versioning.

## Decision

**Single repo with npm workspaces.** All packages live under
`packages/*`; the runtime app sits at the repo root. `npm ci` at
root resolves the workspace graph; `npm run build` builds in
topological order via `tsc -b`.

The repo also hosts `apps/`, `infra/`, and `docs/` siblings to
`packages/`, all sharing the same node_modules and TypeScript
config.

## Consequences

**Wins**

- Cross-package changes land in one PR. Reviewer sees the kernel
  change, the contract update, and the adapter usage together.
- No version coordination — the kernel and adapters are always
  compatible because they're built from the same commit.
- Tooling (eslint, prettier, tsconfig.base) configured once.
- Shared `node_modules` removes duplicate dependency installs;
  the lockfile is the single source of truth.

**Costs**

- The repo is large (~250k LOC). New contributors take longer to
  navigate. We mitigate via focused `packages/*/README.md` files
  and a top-level architecture diagram.
- A bug in a published package (e.g. `@chrono/kernel`) requires a
  full-monorepo build to fix-and-ship. Acceptable — kernel
  releases are infrequent.
- npm workspaces can be quirky with peer-deps; we lock peers
  explicitly in each package and run `npm ls` in CI to catch
  drift.

## Alternatives considered

- **Polyrepo with semver**: rejected — see context.
- **pnpm or Turborepo**: rejected for now — npm workspaces
  satisfies the current need; we don't have build-cache pain
  yet that would justify the migration.
- **Yarn Berry**: rejected — same reason; team is more familiar
  with npm and CI providers handle it natively.

## Related

- [0001 — Kernel zero deps](0001-kernel-zero-runtime-deps.md)
- `package.json` workspaces field
- top-level `tsconfig.json` (composite project references)
