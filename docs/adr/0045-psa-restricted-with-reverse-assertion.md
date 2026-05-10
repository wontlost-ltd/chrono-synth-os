# 0045 — Pod Security Admission: `restricted` enforce + dev reverse-assertion

**Status:** Accepted
**Date:** 2026-Q2 (P0.3 + P0.2 enterprise readiness)
**Scope:** `chrono-synth-deploy/k8s/base/namespace.yaml`, `scripts/validate-k8s.sh`

## Context

Pod Security Admission (PSA) is the in-cluster admission controller
that enforces pod security profiles. Three profiles ship in upstream
K8s:

- **`privileged`** — anything goes.
- **`baseline`** — block obvious privilege escalation (privileged
  containers, hostNetwork, hostPID).
- **`restricted`** — full PCI/SOC2-friendly hardening: runAsNonRoot,
  seccompProfile=RuntimeDefault, allowPrivilegeEscalation=false,
  capabilities.drop=ALL, no hostPath / hostNetwork / hostPID, etc.

Profile is set per-namespace via labels:
`pod-security.kubernetes.io/enforce: <profile>`. Three modes:

- **`enforce`** — admission denial; pod creation blocked if it violates.
- **`audit`** — log a violation event but allow the pod.
- **`warn`** — log + send a warning to kubectl + allow the pod.

The decision is which profile, which mode, in which namespaces.
A second decision arrives later: how do we verify SLO addon (and
similar opt-in observability resources) are *not* present in dev?

## Decision

### Part 1: PSA `restricted` enforce + audit + warn (all three labels)

`namespace.yaml` carries:

```yaml
metadata:
  name: chrono-synth
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
```

All three labels point to `restricted`. The triple is intentional:

- `enforce` — actually blocks bad pods.
- `audit` — same level so audit events match enforcement.
- `warn` — gives developers a kubectl warning *during apply*, not
  just on admission.

All 8 base workloads + alertmanager (in addons) carry pod-level
+ container-level securityContext that satisfies the profile:
runAsNonRoot, capabilities.drop=ALL, allowPrivilegeEscalation=false,
seccompProfile.type=RuntimeDefault.

### Part 2: Reverse-assertion in `validate-k8s.sh` for dev

EP-2.1 + P0.2 wired the SLO addon to staging+prod overlays only,
not dev (see ADR-0040). The risk: someone pastes the addon line into
dev's overlay "for consistency" and dev's prometheus starts
hammering a non-existent alertmanager.

`validate-k8s.sh` therefore has both forward and reverse assertions:

```bash
# Staging + prod must contain SLO components
assert_contains "$staging" 'name: alertmanager'
assert_contains "$prod"    'name: alertmanager'

# Dev must NOT contain them
assert_not_contains "$dev" 'name: alertmanager$' \
  'dev: alertmanager 不应启用'
assert_not_contains "$dev" 'rule_files:' \
  'dev: prometheus.yml 不应含 rule_files 段'
# ... 4 more reverse-assertions
```

A new helper `assert_not_contains` was added for this; it inverts
`assert_contains` semantics.

## Consequences

**Wins (PSA part)**

- "We're SOC2-ready on Kubernetes" is a real claim, evidenceable from
  the namespace manifest. The triple-label pattern is the upstream-
  recommended setup.
- Every workload's securityContext is inspected by CI
  (`validate-k8s.sh` counts capabilities.drop blocks vs workload
  count). Any future workload that forgets these gets caught.
- `audit` + `warn` mode at the same level as `enforce` means
  developers see PSA violations in `kubectl apply` output, not just
  at scheduling time. Faster feedback.

**Wins (reverse-assertion part)**

- Reverse assertions express invariants the forward checks can't.
  "Dev should NOT contain X" is a different shape than "Staging
  SHOULD contain X"; both need explicit gating.
- The SLO addon's "opt-in by design" property survives copy-paste
  refactors. A developer who tries to be helpful by adding the
  addon to dev gets a CI failure with a comment explaining why.

**Costs**

- `restricted` is strict. Any third-party Helm chart we want to add
  must satisfy it; many community charts default to `baseline`.
  Mitigation: we vet third-party additions during their Helm-to-
  kustomize conversion (per ADR-0021).
- The reverse assertion's `assert_not_contains` is text-pattern based,
  not parse-tree based. A future refactor that renames `alertmanager`
  to `alert-manager` would render the reverse assertion ineffective
  silently. Mitigation: the patterns are duplicated against the
  forward staging/prod assertions, so any rename touches both
  sides; PR review catches partial renames.

## Alternatives considered

- **`baseline` instead of `restricted`:** rejected. `baseline` allows
  hostPath, host networking, runAsRoot. Dropping these is the whole
  point of in-cluster hardening.
- **`enforce: restricted`, no `audit`/`warn`:** rejected. Without
  warn, developers don't see PSA violations until they try to deploy
  and the pod gets denied. With warn at the same level, they see
  it on `kubectl apply`.
- **`enforce: baseline`, `warn: restricted`:** rejected. "Warn but
  allow" mode for restricted means we're not actually enforcing the
  hardening. Cosmetic compliance.
- **No reverse assertions (only forward):** rejected. Forward checks
  alone wouldn't catch "dev accidentally got the SLO addon" until a
  human notices. Reverse assertion fails CI immediately.

## How to enforce going forward

- New workloads (in base/ or addon/) MUST have:
  - pod.securityContext: runAsNonRoot, fsGroup, seccompProfile
  - container.securityContext: allowPrivilegeEscalation=false,
    capabilities.drop=[ALL], seccompProfile, readOnlyRootFilesystem
    (where the container can tolerate it)
- `validate-k8s.sh` counts these on every overlay; missing entries
  fail CI.
- "Opt-in features only on staging/prod" pattern:
  - Add forward `assert_contains` for staging + prod
  - Add reverse `assert_not_contains` for dev
  - Both sides in the same loop / same commit
- Don't downgrade PSA profile to `baseline` for any namespace.
  If a third-party chart needs `baseline`, deploy it in a separate
  namespace with its own profile, not by relaxing chrono-synth's.

## Related

- [ADR-0044 — NetworkPolicy: default-deny + per-workload allow](0044-networkpolicy-default-deny.md) —
  paired control
- [ADR-0040 — SLO addon is a kustomize Component](0040-slo-addon-as-component.md) —
  the opt-in addon that motivates the reverse-assertion pattern
- `chrono-synth-deploy/k8s/base/namespace.yaml` — PSA labels
- `chrono-synth-deploy/scripts/validate-k8s.sh` — both forward
  and reverse assertions
- PR `chrono-synth-deploy#1` (P0.3 NetworkPolicy + PSA)
- PR `chrono-synth-deploy#3` (P0.2 SLO addon + reverse-assertions)
