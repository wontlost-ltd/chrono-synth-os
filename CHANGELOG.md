# Changelog

All notable changes to ChronoSynth OS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows
[Semantic Versioning](https://semver.org/) (pre-1.0-GA on the `2.0.0` line).

## [Unreleased]

## [2.0.0-rc.1] — 2026-06-30

First release candidate for `2.0.0` GA — ~172 commits since `2.0.0-beta.7`, hardened and verified.

### Added
- **Per-(tenant, persona) cognitive core isolation** (ADR-0056) — one organization can run multiple distinct digital-employee personas, each born with its own deterministic cognitive core + personality archetype (explorer / guardian / analyst / doer).
- **Digital workforce organization** (M0–M7) — org chart, deterministic decomposition, delegation/reporting, escalation chains, SLA time-awareness, versioned Manager playbooks, bounded autonomous operation, strategy-assist layer.
- **Bidirectional task marketplace + org bidding** (ADR-0058) — organizations bid on, accept, execute, and settle marketplace tasks into an org wallet.
- **Perception as a sensory teacher** (ADR-0051, all phases) — multimodal ingestion → distillation gate → memories; realtime stream, rhythm, and voice perception; GDPR Art.17 media physical-deletion closure.
- **Proactivity** (ADR-0054) — deterministic gate over existing internal signals; outbound nudges, proactive reply enhancement, push delivery groundwork.
- **Job-function-driven learning** (ADR-0057) — gap detection → request → shadow-kernel exam verification → distillation, all zero-LLM at runtime.
- **Humanization** (ADR-0056 humanization) — mood, relationship, temporal awareness, stance, variability, internal drive — all deterministic.
- **BYOK LLM credentials** — per-tenant encrypted key storage + ModelRouter integration.
- Unified design system across `apps/web` / `apps/companion-web` via `@chrono/design-tokens` codegen.

### Changed
- Release images are now **multi-architecture** (linux/amd64 + linux/arm64) — native Apple Silicon / ARM-cloud support.

### Fixed
- **Security:** override `undici` → `^7.28.0` to clear a HIGH advisory; `LocalObjectStorageClient` path-traversal (`../` + symlink) hardening; object-storage GDPR physical-delete fail-closed eraser.
- **CI integrity:** PostgreSQL integration tests isolated per-file (eliminated parallel shared-DB race); `schema-dsl` legacy parity baseline synced to current migrations (v095–v114); `perf` workflow build list completed.
- Numerous audit findings across GDPR import composite-PK isolation, SAFE-EXEMPT tenant SQL ratchet, governance route-layer authorization.

### Security
- Supply chain: cosign keyless signing + SBOM (SPDX) + SLSA provenance on release images; CodeQL / TruffleHog / Trivy (per-arch) / license-allowlist / `npm audit` gates.

## Earlier

`2.0.0-beta.1` … `2.0.0-beta.7` — internal beta line establishing the GA-blocker baseline (multi-tenant isolation, JWT lifecycle, immutable audit chain, supply-chain signing, DR, observability). See `git tag` history and `docs/adr/` for the decision trail.

[Unreleased]: https://github.com/wontlost-ltd/chrono-synth-os/compare/v2.0.0-rc.1...HEAD
[2.0.0-rc.1]: https://github.com/wontlost-ltd/chrono-synth-os/releases/tag/v2.0.0-rc.1
