# 0038 — DAST runs passive baseline only, not full scan

**Status:** Accepted
**Date:** 2026-05 (P0.1 enterprise readiness)
**Scope:** `chrono-synth-os/.github/workflows/security.yml`, `chrono-synth-web/.github/workflows/security.yml`

## Context

P0.1 of the enterprise-readiness track required adding DAST (Dynamic
Application Security Testing) to CI alongside the existing static-
analysis bundle (CodeQL, TruffleHog, license check, SBOM, Trivy).

OWASP ZAP, the obvious tool, ships two action variants:

- `zaproxy/action-baseline` — **passive scan**. Crawls the target,
  inspects HTTP responses, checks headers/cookies/CSP/etc. Does NOT
  send active attack payloads.
- `zaproxy/action-full-scan` — **active scan**. Sends SQLi, XSS,
  command-injection, path-traversal payloads, etc. Catches genuine
  vulnerability classes the baseline can't see.

Both run for ~2-10 minutes against a target URL. We had to pick.

## Decision

**Passive baseline only.** Both `chrono-synth-os` and `chrono-synth-web`
use `zaproxy/action-baseline` against a locally-built production image
on every PR-to-main.

Configuration:

```yaml
- uses: zaproxy/action-baseline@v0.14.0
  with:
    target: 'http://127.0.0.1:3000'
    cmd_options: '-I -T 10'   # ignore info-level, 10-min timeout
    allow_issue_writing: false
    fail_action: false        # collect mode (see ADR-0039)
    artifact_name: zap-baseline-${{ github.sha }}
```

The target backend (or nginx in the web case) is run as a container
on the runner; ZAP scans `http://127.0.0.1:<port>` over the host network.

## Consequences

**Wins**

- Runs on every PR in <3 minutes. Full scan would push CI feedback to
  10+ minutes, which is past the threshold where developers context-
  switch.
- No "destruction" risk. Active scans send malformed payloads that
  can corrupt data, fill logs, exhaust connection pools. Baseline
  doesn't change anything on the target.
- Catches the real-world high-rate-of-occurrence misconfigurations:
  missing security headers (CSP, HSTS, X-Frame-Options), insecure
  cookie attributes, mixed content, robots.txt info leaks. These are
  the bulk of what auditors fault us for.
- Fits CI runners. Active scans require longer container lifetimes,
  bigger memory, and tolerate occasional 5xx as the target chokes —
  hostile to ephemeral CI.

**Costs**

- Doesn't catch SQLi, stored XSS, IDOR, deserialization. We rely on
  CodeQL (SAST) for source-level detection of those classes, plus
  the unit/integration test suite, plus pre-prod manual pen-testing
  before major releases.
- ZAP "passive" still issues real HTTP requests to every discovered
  URL, so a stateful endpoint that has side effects on GET (which
  we don't ship) would be triggered. This is a property the codebase
  invariant enforces; ZAP exposes it by accident if violated.

## Alternatives considered

- **Full scan on every PR:** rejected. Latency + destruction risk.
- **Full scan on cron only (e.g. nightly):** considered, rejected for
  v0. Adds a separate runtime to maintain (target deployment that
  survives between PR merges) and an alerting channel. Worth doing
  later as a quarterly exercise; not on every CI cycle.
- **Schedule the full scan against staging:** correct long-term, but
  blocked by EP-2.1 (real ArgoCD-managed staging cluster). Tracked
  for follow-up.
- **No DAST, rely on CodeQL + manual testing:** rejected. Auditor-
  visibility argument: "is DAST in your CI pipeline?" yes/no is a
  yes-or-no checkbox on every enterprise security questionnaire we've
  ever seen.

## How to revisit

When real staging is wired (post EP-2.1):
1. Add a separate `cron: '0 4 * * 0'` job that runs full-scan against
   `https://chrono.staging.local` from a runner with VPN access.
2. Keep the per-PR baseline scan unchanged.
3. Route active-scan findings to `#chrono-security-tickets`, not
   `#chrono-oncall` (manual triage cadence is fine).

## Related

- [ADR-0039 — ZAP DAST first-run uses fail_action: false (collect mode)](0039-zap-fail-action-collect-mode.md) —
  what to do with the findings the baseline surfaces
- `chrono-synth-os/docs/operations/security-ci-runbook.md` — how to read DAST artifact
- `chrono-synth-web/docs/operations/security-ci-runbook.md` — same for web
- `.github/workflows/security.yml` (both repos) — concrete config
