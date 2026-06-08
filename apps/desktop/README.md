# ChronoSynth Desktop

A native macOS / Linux / Windows client for **ChronoSynth (Enterprise)** —
agent governance for enterprise AI.

The desktop client gives privacy-sensitive operators (regulated-industry
compliance officers, security researchers, individuals running personal
AI agents) the same governance surface as the web console — but with the
audit log and persona memory stored encrypted on-device via SQLCipher,
synced to ChronoSynth's backend through Yrs CRDT for field-level
conflict-free merges.

> 🧭 ChronoCompanion (the consumer-facing C-end product) is planned to ride
> on the same Tauri binary in a "companion mode" toggled by account plan —
> see [ADR-0046](../chrono-synth-os/docs/adr/0046-dual-product-companion.md)
> and `chrono-synth-os/.claude/plan/companion-roadmap.md` Phase 2.4. Today
> this repo only ships the enterprise governance UX.
>
> Product narrative: see `../chrono-synth-os/.claude/gtm/01-pr-faq.md`.

## What's in this repo

- **Tauri 2 shell** (Rust) wrapping a React 19 + Vite frontend, built for
  macOS arm64, Windows x86_64, and Linux x86_64.
- **SQLCipher-encrypted local store** for persona / memory / audit-log
  caches. Encryption key lives in the OS keyring (Keychain on macOS,
  Credential Manager on Windows, Secret Service on Linux).
- **Offline edit queue** + Yrs-based CRDT for persona fields. Offline
  edits replay against the backend on reconnect; concurrent edits across
  devices merge field-level rather than overwriting each other.
- **System tray** integration + auto-update via Tauri's updater plugin
  (signed releases via the GitHub release pipeline).

## Who installs this instead of using the web console

- **Compliance officers** in regulated industries who want the audit log
  to live on a managed device, not in shared browser session storage.
- **Security researchers** running personal AI agents and who care that
  the persona's memory graph never leaves the laptop unencrypted.
- **Multi-device individual operators** who want field-level CRDT merges
  across phone / laptop / workstation rather than last-write-wins.

If you don't fall into one of those buckets, the web console
(`../chrono-synth-web`) is the better choice — fewer moving parts, no
auto-update lifecycle, and identical governance features.

## Status

PoC-grade. The persona list, force-sync, and drift-report flows are
working. ConflictsPage, SettingsPage, and the agent OAuth / pending
confirmations pages are intentional placeholders pending W2-W3 product
work — see `chrono-synth-os/.claude/gtm/` for the timeline.

## Quick start

```bash
# prerequisite: rustup + node 24 + sqlcipher (brew install sqlcipher on macOS)
# run from the MONOREPO ROOT (chrono-synth-os/), not apps/desktop:
npm ci                                   # hoists @wontlost-ltd/schema-dsl to root node_modules
npm run -w @wontlost-ltd/schema-dsl build  # builds its dist/ (build.rs needs it; no prepare script)
npm run -w @chrono/desktop tauri dev     # or `cd apps/desktop && npm run tauri dev`
```

The Rust migration table is generated at build time by `@wontlost-ltd/schema-dsl`.
`src-tauri/build.rs` resolves the CLI in order: `CHRONO_SCHEMA_DSL_CLI` env →
`apps/desktop/node_modules/.bin/schema-dsl-render-rust` → its
`@wontlost-ltd/schema-dsl/bin/render-rust.js` (both legacy standalone) → **the
monorepo root `node_modules/.bin/schema-dsl-render-rust`** (ADR-0049: desktop is a
workspace member, so deps hoist to root) → the in-repo `packages/schema-dsl`
source. The last two (root) candidates resolve to the in-repo package source,
which imports the package's **built `dist/`** — and `dist/` is NOT git-tracked, so
`npm ci` alone is insufficient. build.rs therefore only uses the root candidates
when `dist/` is built; otherwise it panics with build guidance. So run
`npm run -w @wontlost-ltd/schema-dsl build` (or a full `npm run build`, which
`tsc -b` builds all packages) before `npm run tauri dev`. The
`CHRONO_SCHEMA_DSL_CLI` env override remains for differently-laid-out worktrees.

For the production build matrix (signed installers for all three OSes):
see `.github/workflows/release.yml`.

## Key files

| Path | Purpose |
|---|---|
| `src-tauri/src/commands/database.rs` | SQLCipher open + keyring-backed key |
| `src-tauri/src/commands/sync.rs` | Backend fetch + offline queue |
| `src-tauri/src/commands/crdt.rs` | Yrs apply / export |
| `src/pages/PersonaListPage.tsx` | Operator console entry |
| `src/pages/SafetyDriftPage.tsx` | Drift report viewer |
