# Contributing to ChronoSynth OS

Thanks for your interest in contributing. This document covers the dev setup, the quality gate every change must pass, and how decisions are made.

## Licensing of contributions

ChronoSynth OS is dual-licensed (see [`LICENSE`](LICENSE) and [ADR-0022](docs/adr/0022-mit-kernel-agpl-enterprise.md)):

- The **kernel & reusable libraries** (`@chrono/kernel`, `@chrono/contracts`, `@chrono/data-plane`, `@chrono/sync-engine`, `@chrono/design-tokens`, `@chrono/adapter-*`, `@chrono/kernel-testkit`, `@wontlost-ltd/schema-dsl`) are **MIT**.
- The **server** is **AGPL-3.0-or-later**.

By submitting a contribution you agree it is licensed under the license of the package it touches.

## Development setup

Requirements: **Node.js ≥ 24** (see `.nvmrc`), and `podman`/`docker` only if you want to run the full stack.

```bash
npm ci                 # install (use `npm ci`, not `npm install` — see note below)
npm run build          # build workspace packages + main source
npm run test:golden    # the full quality gate (typecheck + build + test + contract + packages + ops + ga:check + licenses)
```

> ⚠️ **macOS note:** always use `npm ci`, not `npm install`. A bare `npm install` on Apple Silicon can rewrite `package-lock.json` and drop Linux-only optional packages (`@emnapi`/`@rolldown` wasi), which then breaks `npm ci` on Linux CI.

To run the whole stack locally (backend + Postgres + a seeded digital-employee org):

```bash
bash deploy/digital-org/deploy.sh        # dev mode (SQLite, fastest)
bash deploy/digital-org/deploy.sh prod   # prod mode (PostgreSQL + queue worker)
```

See [QUICKSTART.md](QUICKSTART.md) for the 5-minute first-run path.

## Before you open a PR

Run the gate locally — CI runs the same:

```bash
npm run test:golden
```

For frontend changes, also run the app-specific checks (e.g. `npm run -w @chrono/web typecheck`, `npm run -w @chrono/web i18n:check`).

A PR should:

- Keep `main` green — `test:golden` must pass.
- Match the surrounding code style (import order, naming, comment density). Comments and docs are written in Simplified Chinese in this codebase; describe intent/constraints, not changelog.
- Be small and reviewable; keep each commit in a working state.
- Fill in the [PR template](.github/pull_request_template.md) (includes the ADR-0050 architecture-budget check).

## How decisions are made

Architectural decisions are recorded as **ADRs** under [`docs/adr/`](docs/adr/README.md). If your change alters an architectural invariant (a red line, an isolation model, the zero-LLM-runtime thesis, etc.), propose or amend an ADR rather than quietly diverging.

## Cross-review

Non-trivial changes are cross-reviewed (generator ≠ reviewer) before merge. Expect review feedback focused on: data-structure fit, special-case elimination, complexity (≤3 indent levels), backward compatibility, and whether the change solves a real problem.

## Reporting bugs / security issues

- **Bugs / feature requests:** open a GitHub issue.
- **Security vulnerabilities:** do **not** open a public issue — see [SECURITY.md](SECURITY.md).
