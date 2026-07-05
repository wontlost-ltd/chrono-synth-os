# ChronoSynth Desktop

A native macOS / Linux / Windows client for **ChronoSynth (Enterprise)** —
agent governance for enterprise AI.

The desktop client gives privacy-sensitive operators (regulated-industry
compliance officers, security researchers, individuals running personal
AI agents) the same governance surface as the web console — but with the
audit log and persona memory stored encrypted on-device via SQLCipher,
synced to ChronoSynth's backend through Yrs CRDT for field-level
conflict-free merges.

> 🧭 ChronoCompanion (the consumer-facing C-end product) rides on the same
> Tauri binary in a "companion mode" toggled by account plan — see
> [ADR-0046](../chrono-synth-os/docs/adr/0046-dual-product-companion.md).
> 自 ADR-0061 起桌面壳**内嵌完整 Node OS sidecar**（见下节），companion + enterprise
> 两套 UX 都由本地 sidecar 供能，双击即用。
>
> Product narrative: see `../chrono-synth-os/.claude/gtm/01-pr-faq.md`.

## 本地安装包：内嵌完整 Node OS（ADR-0061）

自 ADR-0061（S1-S6）起，桌面安装包**内嵌完整 Node OS 服务器作 Tauri sidecar**——不再是纯瘦客户端。
消费者**双击安装即得完整 ChronoSynth**，无需 Docker / Redis / PG，全本地：

- **sidecar** = 打包进安装包的便携 Node 服务器（`resources/sidecar/dist/main-desktop.js` + 生产裁剪
  node_modules + 随附 Node runtime `resources/node`）。Rust `src-tauri/src/sidecar.rs` 启动时 spawn 它，
  绑 `127.0.0.1:0`（动态端口，红线 2 loopback-only），读 stdout `CHRONO_SIDECAR_READY {port,nonce}` 拿端口，
  健康后交前端；退出优雅关停无孤儿（红线 4）。
- **本地会话握手**（红线 11）：per-launch 随机 token（Rust 生成→env 传 sidecar→invoke 传前端），非 public
  端点须带 `X-Chrono-Desktop-Session`——loopback 不是鉴权边界，挡同机其他进程/误连。
- **JWT 签名 secret 持久化 keyring**（红线 5，`resolve_or_create_jwt_secret`）：token 跨重启有效。
- **单机 auto-provision**（S5，`src/bridge/bootstrap-local.ts`）：首启自动建本地 admin（密码存加密 SQLCipher），
  用户零手工配置。
- **SQLite 落 app-data-dir**（红线 3，`CHRONO_DB_PATH`）；卸载不误删用户数据。
- 运行时**零-LLM 铁律不破**（ADR-0047）：内嵌只改分发形态，sidecar 里是同一确定性内核。

**构建/发布**：`.github/workflows/desktop-release.yml`（多平台 matrix + 按目标架构下载锁版本 Node + SHASUMS
校验 + tauri-action 出安装包）。触发 `desktop-v*` tag 或手动 dispatch。

**本地验证全链**（从 monorepo 根）：
```bash
npm run build && node scripts/build-sidecar.mjs   # 产便携 sidecar bundle（--verify 附便携启动冒烟）
npm run e2e:desktop-local                          # S6 端到端：起 bundle → 握手 → auto-provision →
                                                   # companion 零-LLM → per-persona 组织 → T7 → 关停
```

## What's in this repo

- **Tauri 2 shell** (Rust) wrapping a React 19 + Vite frontend, built for
  macOS arm64/x64, Windows x86_64, and Linux x86_64. **内嵌 Node OS sidecar**（ADR-0061，见上）。
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

ADR-0061 S1-S6 已实现：内嵌 Node OS sidecar 的本地安装架构落地，**便携 bundle 本地全链冒烟通过**
（`npm run e2e:desktop-local`——sidecar 起 → 握手 → auto-provision → companion 零-LLM → per-persona 组织 → T7 → 关停）。
持久化本地 persona / memory / audit 经 SQLCipher 加密（key 在 keyring）。

**生产发版前 follow-up**（ADR-0061 标注）：真·干净机双击安装 + 跨平台安装器矩阵实跑 + macOS 公证 /
Windows Authenticode 签名 + 卸载/升级数据保全验证；sidecar 崩溃 auto-restart；build-sidecar staging 依赖锁定。
部分前端页面（ConflictsPage / 某些 agent OAuth 流）仍在完善——见 `chrono-synth-os/.claude/gtm/`。

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
