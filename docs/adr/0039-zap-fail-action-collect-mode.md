# 0039 — ZAP DAST first-run uses fail_action: false (collect mode)

**Status:** Accepted
**Date:** 2026-05 (P0.1 enterprise readiness)
**Scope:** `chrono-synth-os/.github/workflows/security.yml`, `chrono-synth-web/.github/workflows/security.yml`

## Context

ADR-0038 established that we run ZAP baseline (passive scan) on every
PR. ZAP's `fail_action` input determines whether the scan fails the
GitHub Actions job when it finds violations:

- `fail_action: true` — any WARN-NEW or FAIL-NEW alert fails the PR.
  Strict, opinionated; matches the security mantra of "never let
  regressions in".
- `fail_action: false` — alerts are recorded in the artifact but the
  job exits 0. Reports collected without blocking PRs.

The first-time integration of any DAST tool against a real codebase
will surface a backlog of pre-existing issues — typically missing
security headers (CSP, X-Frame-Options, HSTS, Permissions-Policy).
These are real findings; they're also not what *this* PR introduced.

## Decision

**Both `chrono-synth-os#14` and `chrono-synth-web#20` set
`fail_action: false`** for the first ZAP integration. Mode is
"collect baseline, don't block".

The decision *to flip to `fail_action: true`* is a separate
follow-up PR per repo, gated on:

1. Reading the first ZAP artifact and triaging Critical/Serious findings
2. Fixing or knowingly dispositioning each (header gap, cookie attribute,
   etc.) in a focused PR
3. Re-running CI; once the report shows 0 Critical + 0 Serious,
   flip `fail_action: true`

This is documented in both repos' `docs/operations/security-ci-runbook.md`
under "DAST baseline → 切到 hard-fail 模式".

## Consequences

**Wins**

- The PR that *adds* DAST integration doesn't block on issues it
  didn't introduce. If we'd set `fail_action: true` from day one,
  that PR would surface ~8 missing-header warnings (web's actual
  baseline) and we'd have to choose between (a) fixing them all in
  the same DAST PR or (b) skipping the WARN level. (a) inflates the
  PR; (b) defeats the purpose of having WARN level at all.
- Establishes a baseline artifact that triagers can read offline.
  No "Slack me when ZAP fails CI" loop; the report is on the run.
- Decouples "we have DAST" (P0) from "DAST is hard-fail" (post-P0
  follow-up). Both are valuable; bundling them collapses two
  decisions into one.

**Costs**

- Until the flip happens, a regression that introduces a *new*
  serious header gap won't fail the PR. Mitigation: PR review +
  the artifact diff between PRs is comparable manually.
- "We'll flip it later" creates a forever-todo if no one tracks
  it. Mitigation: the follow-up flip is the explicit DoD criterion
  in `docs/operations/security-ci-runbook.md`. Calendar reminder
  set for 2 weeks post-merge of P0.1.

## Alternatives considered

- **`fail_action: true` from the start, fix headers in the same PR:**
  rejected. Bundles two distinct concerns (CI infra + actual fixes)
  into one PR; review takes 3× longer; revert is harder.
- **`fail_action: true` from start with allow-list of known issues:**
  rejected. ZAP supports a rules.tsv file to suppress specific
  rules. Building that allow-list is itself triage work; doing it
  upfront is the same as just doing the fixes upfront.
- **Permanent collect mode (never flip to hard-fail):** rejected.
  Defeats the point of CI gating; we'd be paying for ZAP runtime
  with no protection. Required to flip eventually.

## How to enforce going forward

The follow-up PRs are tracked under EP-2.4-followup tasks (or as
direct issues). Each repo's flip is independent:

- **os**: after first run shows 0 Critical/Serious, single-line
  config change `fail_action: true` in `.github/workflows/security.yml`.
- **web**: same. Web has 8 known WARN-NEW from P0.1 first run; fixing
  them is part of the design-system work in EP-2.4 (CSP / Permissions-Policy /
  X-Content-Type-Options are layout-tier concerns that the design
  system PR is well-positioned to address).

When flipping, also:
1. Update both `security-ci-runbook.md` files to remove the
   "collect mode" caveat
2. Note the flip date in the runbook history

## Related

- [ADR-0038 — DAST runs passive baseline only](0038-dast-passive-baseline.md)
- `chrono-synth-os/docs/operations/security-ci-runbook.md` § DAST baseline
- `chrono-synth-web/docs/operations/security-ci-runbook.md` § DAST baseline
- PR `chrono-synth-os#14` first DAST integration
- PR `chrono-synth-web#20` first DAST integration
