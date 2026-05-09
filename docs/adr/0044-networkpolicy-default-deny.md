# 0044 — Kubernetes NetworkPolicy: default-deny + per-workload allow

**Status:** Accepted
**Date:** 2026-Q2 (P0.3 enterprise readiness)
**Scope:** `chrono-synth-deploy/k8s/base/network-policy.yaml`

## Context

Out of the box, Kubernetes pods can talk to any other pod in the
cluster — no namespace boundary, no per-service firewall. For a
multi-tenant SaaS this is a meaningful attack surface: a compromised
pod (e.g. a vulnerable image we just rolled) gets unrestricted
lateral movement.

K8s NetworkPolicy is the in-cluster firewall. Two philosophical
modes:

- **Allow-list / default-deny:** start with no traffic permitted,
  add explicit rules per workload. Surface area is bounded by what
  you write down. Common compliance pattern (SOC2, HIPAA, FedRAMP).
- **Deny-list / default-allow:** start with everything permitted,
  add explicit blocks for known-bad. Cheap to introduce but trivial
  to bypass; new workloads inherit no policy.

P0.3 (NetworkPolicy + PSA) committed to default-deny. This ADR
captures *why* and the implementation pattern.

## Decision

**Default-deny for all pods, plus per-workload allow rules.**

Implementation: `k8s/base/network-policy.yaml` defines:

1. **`default-deny-all`** — selects every pod, deny all ingress + egress.
2. **`allow-dns-egress`** — selects every pod, allow UDP/TCP 53 to
   `kube-system` namespace's `kube-dns` pods. Any pod that does any
   network call needs DNS first; making DNS the universal allow keeps
   per-workload policies focused on actual app traffic.
3. **One workload-specific NetworkPolicy per service** — backend,
   frontend, observability-worker, postgres, redis, prometheus,
   grafana, jaeger, alertmanager (added via SLO addon). Each
   declares ingress + egress rules naming the peer workload by
   `app.kubernetes.io/name` label.

Example, the `backend-policy`:

```yaml
ingress:
  - from:
      - podSelector: { matchLabels: { app.kubernetes.io/name: chrono-synth-web } }
      - podSelector: { matchLabels: { app.kubernetes.io/component: ingress } }
    ports: [{ protocol: TCP, port: 3000 }]
egress:
  - to:
      - podSelector: { matchLabels: { app.kubernetes.io/name: postgres } }
    ports: [{ protocol: TCP, port: 5432 }]
  - to:
      - podSelector: { matchLabels: { app.kubernetes.io/name: redis } }
    ports: [{ protocol: TCP, port: 6379 }]
  # ... kafka, jaeger:4318, external HTTPS, ...
```

External egress (Stripe / OAuth / KMS endpoints) goes through a
single `ipBlock: 0.0.0.0/0 except [RFC1918]` rule with port 443 only.
Tighter SNI/IP pinning belongs at the CNI layer (Cilium / Calico
GlobalNetworkPolicy), not core Kubernetes NetworkPolicy.

## Consequences

**Wins**

- Lateral movement from a compromised pod is bounded by the explicit
  allow rules. Backend pop has no path to e.g. grafana or jaeger
  except via 4318 OTLP egress (one direction, defined port).
- Adding a new workload requires *also* adding its NetworkPolicy.
  The CI gate in `validate-k8s.sh` checks that every workload has
  a dedicated `<name>-policy`; missing one fails the PR. P0.3 found
  jaeger had no policy and added one.
- SOC2 / similar audits ask "do you implement zero-trust networking
  inside the cluster?" yes/no. With this pattern the answer is yes;
  the evidence is `network-policy.yaml`.

**Costs**

- Adding a new workload now requires writing both Deployment +
  Service + NetworkPolicy. ~15 extra lines of YAML.
- Debugging "why can't pod A talk to pod B" starts with `kubectl
  describe networkpolicy` instead of `kubectl get pods`. Mitigation:
  the per-workload policy file is short and readable; the
  `validate-k8s.sh` assertion lists every workload-policy mapping
  in plain text.
- External egress allow uses `ipBlock: 0.0.0.0/0` minus RFC1918,
  not specific Stripe / OAuth / KMS IPs. Tightening that requires
  a CNI that supports DNS / FQDN policies (Cilium or Calico
  Enterprise). For the v0 setup, the `0.0.0.0/0:443` allow + RFC1918
  block is the practical 80/20.

## Alternatives considered

- **No NetworkPolicy (default-allow):** rejected, see Context.
  Zero-trust is the table stakes for an enterprise sale.
- **One mega NetworkPolicy with all rules:** rejected. Single file
  becomes unmaintainable as new workloads land. Per-workload files
  let you delete a NetworkPolicy alongside its Deployment.
- **`networking.istio.io` / Cilium L7 policies as the primary mechanism:**
  long-term yes, but requires the cluster to have a service mesh
  installed. v0 uses core K8s `NetworkPolicy` so the manifest works
  on any conformant cluster (k3s, EKS, GKE, AKS).

## How to enforce going forward

- Adding a new workload to `k8s/base/` requires:
  1. Deployment / StatefulSet
  2. Service (if other pods need to call it)
  3. NetworkPolicy named `<workload>-policy` selecting the
     workload's pods, declaring ingress (who calls it) + egress
     (who it calls).
- `scripts/validate-k8s.sh` enforces every workload has a dedicated
  NetworkPolicy. Adding a workload without one fails CI.
- Cross-namespace traffic uses `namespaceSelector`. Document the
  allowed peer namespaces in the policy's comments — these are the
  trust boundary.
- External egress beyond port 443 requires its own rule with
  justification in the YAML comments.

## Related

- [ADR-0045 — Pod Security Admission: restricted enforce + dev reverse-assertion](0045-psa-restricted-with-reverse-assertion.md) —
  paired control; default-deny networking + restricted PSA = baseline
  zero-trust posture
- `chrono-synth-deploy/k8s/base/network-policy.yaml` — concrete rules
- `chrono-synth-deploy/scripts/validate-k8s.sh` — workload→policy assertion
- PR `chrono-synth-deploy#1` (P0.3 NetworkPolicy + PSA + CI assertions)
