# 0020 — ArgoCD over Flux for GitOps

**Status:** Accepted
**Date:** 2026-Q1 (P1.2)
**Scope:** `chrono-synth-deploy/argocd/*`

## Context

We picked GitOps for kubernetes deployment in P1.2. The two leading
controllers are ArgoCD and FluxCD. Both are CNCF-graduated, both
implement reconcile-from-git, both have ApplicationSet-equivalents.
The decision points came down to operator UX, RBAC granularity, and
the team's existing tools.

## Decision

**ArgoCD v2.13 in HA install mode.** ApplicationSet drives
dev/staging/prod from a single template, AppProject scopes RBAC and
allowed source repos, and `syncPolicy.automated.selfHeal=true` keeps
the cluster aligned even when a human reaches in with kubectl.

Configuration in `chrono-synth-deploy/argocd/`:

- `install/argocd-install.yaml` — kustomize bootstrap pinning the
  upstream release.
- `projects/chrono-synth.yaml` — AppProject (sourceRepos,
  destinations, resource whitelist, RBAC roles).
- `applicationsets/chrono-synth.yaml` — three-element ApplicationSet
  (dev / staging / prod).

## Consequences

**Wins**

- Built-in web UI is invaluable during incident response. Engineers
  can see what's deployed, click sync, view diff against git
  without dropping into kubectl. Flux requires Weave GitOps or
  `flux` CLI for the same affordances.
- ApplicationSet's list generator is more flexible than Flux's
  Kustomization variant; we expand to multi-cluster federation
  later by switching the generator type, no spec rewrite.
- AppProject RBAC scopes both source repos and destination
  namespaces; we get a defensible "this controller can only deploy
  these things to these places" without needing to layer Kyverno.
- Rollback UX (`argocd app rollback`) is one command; Flux requires
  `git revert` + reconcile.

**Costs**

- Larger memory footprint than Flux. Acceptable for our scale.
- ArgoCD's sync windows are powerful but the syntax is quirky;
  documented in [`gitops-runbook.md`](../../chrono-synth-deploy/docs/operations/gitops-runbook.md).
- Updates require a kustomize rebuild against the pinned upstream
  ref. Flux ships a single CRD bundle that's marginally simpler
  to upgrade. We accept the trade for the UI.

## Alternatives considered

- **FluxCD**: rejected — the team already runs ArgoCD in another
  product; consolidating tooling matters more than the marginal
  resource savings.
- **Spinnaker**: rejected — too heavy for a single-cluster
  deployment.
- **Bare `kubectl apply -k` from CI**: rejected — no drift
  detection, no rollback, no audit trail.

## Related

- [`chrono-synth-deploy/docs/operations/gitops-runbook.md`](../../chrono-synth-deploy/docs/operations/gitops-runbook.md)
- [`chrono-synth-deploy/argocd/`](../../chrono-synth-deploy/argocd/)
- P1.2 in `enterprise-readiness-2026.md`
