# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ChronoSynth OS, **please report it privately** — do not open a public issue, PR, or discussion that discloses the details.

**Contact:** [ryan.pang@wontlost.com](mailto:ryan.pang@wontlost.com) (subject line prefixed `[SECURITY]`).

Please include, where possible:

- A description of the vulnerability and its impact.
- Steps to reproduce (or a proof-of-concept).
- Affected version / commit (see [Supported Versions](#supported-versions)).
- Any suggested remediation.

We will acknowledge your report within **2 business days** and aim to provide a remediation timeline after triage. Please give us a reasonable window to ship a fix before any public disclosure (coordinated disclosure).

## Supported Versions

ChronoSynth OS is pre-1.0-GA; the `2.0.0` line is under release-candidate hardening.

| Version | Supported |
|---------|-----------|
| `2.0.0-rc.x` (current pre-release) | ✅ security fixes |
| `2.0.0-beta.x` (older pre-releases) | ⚠️ upgrade to latest rc |
| `< 2.0.0` | ❌ |

Once `v2.0.0` GA ships, this table will be updated to track the supported GA + previous minor.

## What we already enforce

The release pipeline and CI bake in a number of supply-chain and runtime controls — useful context when assessing a report:

- **SAST** — CodeQL on every push/PR/weekly, gated on HIGH+ findings.
- **Secret scanning** — TruffleHog on push/PR/weekly (verified + unknown).
- **Dependency audit** — `npm audit --audit-level=high` is a CI gate (0 HIGH/CRITICAL required).
- **Image scanning** — Trivy on release images (GA blocks CRITICAL+HIGH; pre-release blocks CRITICAL), scanned per-architecture (amd64 + arm64).
- **Image signing** — cosign keyless (Sigstore/Fulcio OIDC), signed by digest; SBOM (SPDX) + SLSA build provenance attested to every release image.
- **License boundary** — non-allowlisted licenses (GPL-3 / AGPL in dependencies, etc.) are rejected.
- **Runtime** — multi-tenant row-level isolation, JWT key rotation + revocation, field-level encryption, SSRF egress guard, rate limiting + backpressure, immutable audit hash-chain, GDPR export/erase (fail-closed).

See `docs/operations/security-ci-runbook.md` for the CI security gate runbook.

## Scope

In scope: the `chrono-synth-os` server, kernel packages (`@chrono/*`, `@wontlost-ltd/schema-dsl`), and the bundled client apps (`apps/web`, `apps/companion-web`, `apps/mobile`, `apps/desktop`).

Out of scope: third-party dependencies (report upstream), and deployment-repo infrastructure (`chrono-synth-deploy`) which is tracked separately.
