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
npm install
npm run tauri dev
```

The Rust migration table is generated at build time by `@wontlost-ltd/schema-dsl`.
`src-tauri/build.rs` first looks for `../node_modules/.bin/schema-dsl-render-rust`
and then `../node_modules/@wontlost-ltd/schema-dsl/bin/render-rust.js`. Until the
package is published and installed from GitHub Packages, set
`CHRONO_SCHEMA_DSL_CLI` to a local `packages/schema-dsl/bin/render-rust.js`
worktree path before running Cargo/Tauri commands.

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
