# 0041 — ArgoCD sync waves: 6-band (-10 / -5 / 0 / 5 / 10 / 15)

**Status:** Accepted
**Date:** 2026-05 (EP-2.1 ArgoCD wiring)
**Scope:** `chrono-synth-deploy/k8s/base/`, `k8s/addons/observability-slo/`

## Context

ArgoCD applies resources in **wave** order: lower waves first, wait
for Healthy, then proceed. Without explicit waves, all resources
apply in parallel and ArgoCD reaches eventual consistency through
self-heal — but the first sync (or any large refresh) sees
CrashLoopBackOff churn while pods wait for their dependencies to
become Healthy.

When EP-2.1 audited the deploy repo, **zero** sync-wave annotations
existed. We had to design a banding scheme.

The simplest scheme is a single divider: "data tier first, everything
else second." That's two waves. The full Google SRE pattern uses
many more (one per dependency edge). Both extremes have failure modes:

- Too few waves (2-3) — pods still hit dependencies that are in the
  same wave (e.g. backend depends on postgres but they're in the
  same band).
- Too many waves (10+) — every new component is a Slack thread
  about which wave to assign. Cognitive overhead on every PR.

## Decision

**6 waves: -10, -5, 0, 5, 10, 15**.

```
wave -10  Namespace + NetworkPolicy
              │ (must exist before any pod, so default-deny doesn't
              │  catch in-flight pods on first sync)
wave  -5  ConfigMap + Secret
              │ (pods reference these at startup)
wave   0  Data tier: postgres + redis
              │ (backend readiness probe pings them)
wave   5  Business tier: backend + observability-worker
              │ (frontend nginx proxies to them; prometheus scrapes)
wave  10  Observability + frontend tier
              │ (frontend, prometheus, grafana, jaeger, alertmanager)
wave  15  Ingress
              (open external traffic LAST so a half-up stack
               never serves users)
```

Gaps of 5 between waves are deliberate: future components can
slot in at -7, -3, 7, 12, etc. without renumbering.

Within a wave, ArgoCD applies in parallel. We don't try to make
redis wait for postgres because it doesn't depend on it; both are
"data tier", both can come up together.

**Generated ConfigMaps** (kustomize `configMapGenerator` outputs:
prometheus-config, grafana-dashboards, etc.) intentionally lack
explicit annotations and default to wave 0. Their consumers run at
wave 10+, so the ConfigMap is always ready when the pod mounts.
Documented in `docs/operations/gitops-runbook.md`.

## Consequences

**Wins**

- First-time bootstrap and large refreshes complete cleanly. No
  CrashLoopBackOff while postgres rolls; no 504 from frontend
  while backend rolls; no scrape errors before backend exports
  metrics.
- The wave choice for any new component is a 30-second decision:
  what does it need at startup? Pre-pod (-10/-5), data layer (0),
  business layer (5), consumer (10), edge (15).
- 5-wide gaps mean future components like a service mesh (sits
  between business and consumer at wave 7-8) or a SLO-test injector
  (between 10 and 15) slot in without renumbering existing waves.
- Explicit waves on Service resources (alongside their parent
  Deployment/StatefulSet) keep dependent pods from finding stale
  endpoints. Service at wave 0 + Deployment at wave 0 means the
  Service shows up the moment the Deployment's pods do.

**Costs**

- 6 waves means 6 sequential Healthy-checks per sync, adding ~30s
  to a clean refresh in our cluster size. Acceptable; the upside is
  no operator noise.
- Two systems must remain in sync: the annotation values in YAML
  and the runbook narrative explaining what each wave means. The
  CI assertion in `validate-k8s.sh` checks every workload has *some*
  wave; it doesn't check the wave value matches the runbook.
  Mitigation: PR review.

## Alternatives considered

- **2 waves (data, then everything else):** rejected. Backend at
  same wave as postgres = backend pod crashloops on first sync until
  postgres rolls.
- **Sync-wave per-component (one wave per service, depend chain):**
  rejected. Adds 8+ waves; each new resource a debate. The 6-band
  abstraction collapses "things that depend on the same tier" into
  one wave, which is what humans actually want.
- **Don't use sync-waves, rely on retry + self-heal:** rejected.
  ArgoCD does eventually converge but pages NOC during the
  convergence window with "OutOfSync" + Pod CrashLoopBackOff alerts.
- **Sync-wave 0 only (default), use init-containers for ordering:**
  rejected. Init-containers serialize *within* a pod, not across
  pods. Doesn't help with "frontend pod waits for backend pod".

## How to enforce going forward

- Adding a manifest? Pick the wave by what it depends on at startup:
  - Pre-pod (NetworkPolicy, namespace) → -10
  - ConfigMap / Secret → -5
  - Stateful tier with no in-cluster deps → 0
  - Business service that calls into 0 → 5
  - Consumer of business tier → 10
  - External-facing edge → 15
- When in doubt, use 10. Slightly later is safer.
- `validate-k8s.sh` enforces baseline coverage (every workload has
  some annotation). The wave value itself isn't gated by CI; it's
  reviewable in PR.
- Generated ConfigMaps from `configMapGenerator` are intentionally
  unwaved (= wave 0). Don't paper over with a patch unless that
  ConfigMap becomes critical-path for an *earlier* wave.

## Related

- [ADR-0020 — ArgoCD over Flux](0020-argocd-over-flux.md)
- [ADR-0021 — kustomize over Helm](0021-kustomize-over-helm.md)
- [ADR-0040 — SLO addon is a kustomize Component](0040-slo-addon-as-component.md) —
  the addon's resources fit into this wave scheme
- `chrono-synth-deploy/docs/operations/gitops-runbook.md` § Sync waves
- PR `chrono-synth-deploy#8` (sync-wave annotations + CI assertions)
