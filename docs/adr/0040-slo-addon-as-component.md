# 0040 — SLO addon is a kustomize Component (not a Kustomization)

**Status:** Accepted
**Date:** 2026-05 (P0.2 SLO monitoring)
**Scope:** `chrono-synth-deploy/k8s/addons/observability-slo/`

## Context

The SLO monitoring stack (alertmanager, recording rules, alerts,
chrono-slo grafana dashboard, augmented prometheus.yml with
`alerting:` + `rule_files:` blocks) is opt-in: dev doesn't include
it (no traffic = no SLI signal = noisy NaN dashboards), staging and
prod do.

The natural kustomize structure for an opt-in bundle is "an addon
directory referenced from overlays that want it". Two flavors:

- **`apiVersion: kustomize.config.k8s.io/v1beta1` + `kind: Kustomization`**
  — a self-contained sub-kustomization. Referenced from overlays via
  `resources: [../../addons/observability-slo]`. Generators and
  patches inside the addon resolve against *only the addon's own
  resource graph*.
- **`apiVersion: kustomize.config.k8s.io/v1alpha1` + `kind: Component`**
  — an "inlining" bundle. Referenced from overlays via
  `components: [../../addons/observability-slo]`. Generators and
  patches inline into the calling overlay's resource graph and can
  see everything the overlay sees.

The two look almost identical at first glance. They diverge sharply
in one place: **`configMapGenerator` with `behavior: replace`**.

The SLO addon needs to **replace** the base's `prometheus-config`
ConfigMap with an SLO-augmented version (adds `rule_files:` and
`alerting:` blocks). `behavior: replace` requires the original
ConfigMap to be visible in the resource graph at the moment the
generator runs.

A plain Kustomization addon can't see base's resources — so
`behavior: replace` errors with `prometheus-config does not exist;
cannot merge or replace`. A Component, because it inlines into the
caller, sees base just fine.

## Decision

**The SLO addon is a `kind: Component`**.

```yaml
# k8s/addons/observability-slo/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
namespace: chrono-synth
resources: [...]
configMapGenerator:
  - name: prometheus-config
    behavior: replace        # <-- requires Component, not Kustomization
    files: [prometheus.yml=prometheus-slo.yml]
patches: [...]
```

Overlays opt in via `components:`:

```yaml
# k8s/overlays/staging/kustomization.yaml
resources: [../../base]
components: [../../addons/observability-slo]
```

Dev's overlay doesn't include the components line; SLO never gets
inlined.

## Consequences

**Wins**

- `behavior: replace` works as designed; staging + prod's
  `prometheus-config` ConfigMap is the augmented version with
  `alerting:` block, dev's is base's plain one.
- "Opt-in monitoring" semantics are explicit at the overlay level.
  Anyone reading `staging/kustomization.yaml` can see `components:
  observability-slo` and understand that staging gets SLO; the
  inverse for dev.
- Components also can patch addon-owned resources additively
  (alertmanager Service, NetworkPolicy patch) without conflict.
  All three patch types — strategic merge for prometheus mounts,
  strategic merge for grafana SLO dashboard mount, JSON 6902 for
  netpol egress append — work cleanly inside a Component.

**Costs**

- `kind: Component` is less commonly used than `kind: Kustomization`.
  A future contributor unfamiliar with the distinction might try to
  refactor "this is just an addon, why is it a Component?" Mitigation:
  in-file comment at the top of the addon's `kustomization.yaml`
  explains the choice.
- The `apiVersion` is `v1alpha1` (Components are still alpha-tagged
  in kustomize as of 5.x). They're stable in practice — used by
  thousands of repos — but a major kustomize version bump could
  technically break us. Pin tracks `kustomize-version` in CI; we
  upgrade with a regression test.

## Alternatives considered

- **Plain Kustomization addon, no `behavior: replace`**: rejected.
  The alternative way to swap prometheus.yml is to manage the
  ConfigMap entirely from the addon (and not from base). Then dev
  doesn't get a prometheus-config at all unless we re-introduce one,
  pushing the dev/staging/prod parity into the base layer. The
  "addon owns the augment" pattern is cleaner.
- **Two prometheus ConfigMaps, one named `prometheus-config-slo`,
  reference it from a deployment patch:** rejected. The deployment
  patch would have to swap `volume[].configMap.name` per overlay,
  which is exactly the kind of scattered configuration the addon
  pattern is supposed to eliminate.
- **Helm chart instead:** out of scope; ADR-0021 says we use
  kustomize, not Helm.
- **One mega-overlay with conditional includes:** rejected. Components
  are kustomize's blessed way to do conditional includes. Inventing
  our own is reinventing the wheel.

## How to enforce going forward

- New addons that need to **replace** existing base resources MUST
  use `kind: Component`. Plain Kustomization addons are fine for
  pure additions (no replace).
- Overlays reference Components in the `components:` list, not
  `resources:`. `validate-k8s.sh` currently checks for the
  observability-slo addon presence in staging+prod; future addons
  should add similar coverage.
- Don't downgrade `kind: Component` to `kind: Kustomization` "for
  consistency". The `behavior: replace` on `prometheus-config` is
  load-bearing.

## Related

- [ADR-0021 — kustomize over Helm](0021-kustomize-over-helm.md) —
  why we're in kustomize-land in the first place
- [ADR-0041 — ArgoCD sync waves: 6-band](0041-argocd-sync-waves-6-band.md) —
  consumes the addon's wave annotations
- `chrono-synth-deploy/k8s/addons/observability-slo/kustomization.yaml`
  — concrete config with apiVersion/kind comment
- PR `chrono-synth-deploy#3` (P0.2 SLO wiring)
