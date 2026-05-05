# 0018 — Tauri over Electron for the desktop app

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `chrono-synth-desktop` repo

## Context

Chrono Synth ships a desktop app for users who want a local-first,
always-available persona without keeping a browser tab open. The
desktop app reuses ~70% of the web React code through `@chrono/
adapter-web` and adds a thin Rust backend for OS integrations
(notification center, system tray, native menus, file system access
without Web FS API quirks).

The packaging-shell choice was either Electron (Chromium + Node.js
shipped in-app) or Tauri (system WebView + Rust shipped in-app).

## Decision

**Tauri.** Specifically Tauri v2.x with the IPC-based command
bridge, embedding the system WebView (WebKit on macOS, WebView2 on
Windows, WebKitGTK on Linux).

Bundle targets: `.dmg` (macOS), `.msi` + `.exe` (Windows), `.AppImage`
+ `.deb` (Linux).

## Consequences

**Wins**

- Bundle size: ~12 MB vs Electron's ~120 MB. Users notice.
- Memory: ~80 MB idle vs Electron's ~250 MB.
- Security: smaller attack surface (no Node.js APIs in the
  renderer; IPC bridge is explicit).
- Code signing & notarization tooling is first-class in Tauri v2.
- Rust backend integrates cleanly with our existing kernel patterns
  (the web app uses a Web Worker, the desktop uses a Tauri command;
  both speak `WebUnitOfWork`).

**Costs**

- WebView fragmentation. WebKit on macOS lags Chrome by 1–2
  releases on some web platform features (View Transitions API,
  `dialog` element behavior). We test on the WebView backends in CI
  via a `tauri build` matrix; design tokens use feature-detected
  fallbacks.
- The Rust learning curve for engineers who only know TS. We
  bound this by making the Rust side intentionally thin — only
  OS integrations, no domain logic. Domain stays in the kernel.
- Auto-update infrastructure is more DIY than Electron's
  `electron-updater`. We use Tauri's built-in updater pointed at
  S3-hosted manifests; covered separately by [ADR 0019] (planned).

## Alternatives considered

- **Electron**: rejected — see context. Bundle size and memory
  alone outweigh the convenience for a productivity-class app.
- **Native Swift/Kotlin/WPF per platform**: rejected — would
  triple the desktop engineering surface and split the code from
  web.
- **Wails (Go)**: rejected — Go's web tooling is less mature for
  our stack, and we already have Rust expertise from kernel
  perf experiments.

## Related

- [0019 — desktop auto-update + signing](#) (planned)
- `chrono-synth-desktop/src-tauri/`
- [P2.1 in `enterprise-readiness-2026.md`](#) — desktop Rust backend roadmap
