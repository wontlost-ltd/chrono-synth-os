# 0021 — kustomize over Helm for K8s manifests

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** `chrono-synth-deploy/k8s/*`

## Context

We ship Kubernetes manifests for the chrono-synth deployment. Two
templating approaches dominate the ecosystem:

1. **Helm** — package manifests as charts with templated YAML, values
   files for environment overrides, install/upgrade lifecycle hooks,
   and a registry of published charts.
2. **kustomize** — overlay-based: a `base/` directory holds raw
   manifests, and `overlays/dev|staging|prod` mutate them via
   strategic merge patches. No templating language.

The deployment surface is small (~15 deployments + addons) and we
control all of it; we don't need a public chart registry.

## Decision

**kustomize.** Layout under `chrono-synth-deploy/k8s/`:

```
base/
  backend/, frontend/, postgres/, observability-worker/, ...
  kustomization.yaml
overlays/
  dev/      kustomization.yaml + dev-only patches
  staging/  kustomization.yaml + staging patches
  prod/     kustomization.yaml + HPA, PDB, prod patches
addons/
  observability-slo/, ...
```

ArgoCD's ApplicationSet ([ADR 0020](0020-argocd-over-flux.md)) points
at the overlay directories directly — no chart packaging step.

## Consequences

**Wins**

- Manifests stay readable. Anyone who knows YAML can understand the
  base; reviewers don't have to mentally render Go templates.
- Strategic merge patches are localized — a patch file shows exactly
  what one overlay changes. Helm's templated `if`/`else` can hide
  cross-environment differences across the file.
- No release versioning overhead. The repo's git history is the
  release log.
- Kubernetes-native: `kubectl apply -k`, `kubectl diff -k`, no extra
  binary on operator workstations.

**Costs**

- Reusing manifests across orgs (e.g., publishing an open-source
  install) is harder. Helm charts are the lingua franca for that.
  We accept this — internal first, charts later if customer demand
  exists ([P3.5](#) tracks a parallel Helm chart).
- Patching deeply-nested fields requires careful JSON6902 path
  syntax. Kustomize beginners trip on this; we maintain a small
  cheat-sheet inline in `chrono-synth-deploy/README.md`.

## Alternatives considered

- **Helm**: rejected — see context.
- **Pulumi / cdk8s**: rejected — programmatic IaC for K8s manifests
  is overkill at our scale; introduces a TS/Python build step into
  the deploy repo.
- **Raw manifests, no overlays**: rejected — three nearly-identical
  copies would drift.

## Related

- [0020 — ArgoCD over Flux](0020-argocd-over-flux.md)
- `chrono-synth-deploy/k8s/`
