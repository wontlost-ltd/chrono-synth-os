# Capacity Planning

This document gives you a defensible answer to "how big does the cluster need
to be to serve N tenants × M personas × R messages-per-day?". It pairs with
the perf suite under [`perf/`](../../perf/) and the SLOs in
[`slo-runbook.md`](slo-runbook.md).

## TL;DR for the impatient

A single backend pod (1 vCPU, 1 GiB) with a co-located PostgreSQL primary
and Redis sustains roughly:

| Workload                   | Sustained RPS | Saturation point | Bottleneck observed |
| -------------------------- | -------------- | ---------------- | ------------------- |
| Conversation (msg send)    | ~120          | ~180             | LLM upstream concurrency |
| Agent tool call (low-risk) | ~80           | ~120             | DB write contention on `tool_invocations` |
| Portability export start   | rate-limited at 5/min/tenant | n/a | by design |

These numbers are observed on the `ramp` profile against the staging
cluster and revalidated weekly by the [Perf workflow](../../.github/workflows/perf.yml).
Treat them as a starting point; re-measure before committing to a customer
SLA.

## Sizing formula

For a deployment with **T tenants** averaging **P personas/tenant** and
**M messages/persona/day**:

```
Daily message RPS  = (T · P · M) / 86 400
Peak/avg multiplier = 4×          # observed peak-to-mean across customers
Required conversation RPS = Daily RPS × 4
```

Then divide by the **per-pod sustained RPS** from the table above and add
the platform's **HPA headroom multiplier** (we run 1.4×) to size the
deployment:

```
Replica count (conversation) = ceil(Required RPS / 120) × 1.4
```

Apply the same shape to agent tool calls. Portability is not RPS-bound;
size DB / object storage instead.

### Worked example

A customer projects 2 000 tenants × 4 personas × 30 messages/day:

```
Daily RPS  = (2 000 · 4 · 30) / 86 400 ≈ 2.78
Peak RPS   = 2.78 × 4 ≈ 11.1
Replicas   = ceil(11.1 / 120) × 1.4 = 1 × 1.4 → 2
```

Two pods cover the conversation surface. We always run at least three for
availability, so this customer fits inside the baseline.

## Per-resource scaling

### PostgreSQL

The dominant write hotspots are `tool_invocations` (one row per call) and
`audit_log` (one row per privileged action). At 200 tool calls/sec the
master sustains ~1.2k inserts/sec including index maintenance — well below
modern SSD limits but worth watching.

**Vertical scale first.** Move to 4 vCPU / 16 GiB before adding read
replicas. Replica lag adds complexity (the kernel's
`SyncWriteUnitOfWork` reads its own writes; cf
[ADR 0002](../adr/0002-sync-write-unit-of-work.md)) so prefer a beefier
primary until you hit ~600 sustained writes/sec.

Run `EXPLAIN ANALYZE` on the slow-query log monthly. The retention job
(see [ADR 0010](../adr/0010-retention-env-tunable.md)) keeps tables
bounded.

### Redis

Redis carries:

- API-key cache (read-mostly, eviction-tolerant)
- Rate-limit counters (write-heavy under attack)
- Idempotency keys (TTL ≤ 24 h)

A single 1 GiB `redis:8` node carries ~500 RPS of mixed workload. Use
Sentinel for HA before sharding; we hit network overhead before hitting
Redis CPU.

### LLM upstream

Conversation latency is dominated by the LLM provider, not us. Plan
concurrency based on:

```
LLM concurrent budget = (Conversation RPS) × (avg p95 LLM latency) / 1000
```

For 120 RPS at 800 ms p95: ~96 concurrent LLM requests. Negotiate a
provider rate limit ≥ 1.5× this number; we throttle gracefully via
`conversation_quota_exceeded_total` (see metrics) but every throttled
request is a degraded user experience.

## Observability hooks

The perf workflow surfaces these metrics; production exposes the same
names so you can build apples-to-apples dashboards:

- `chrono_request_duration_seconds` (histogram, by route)
- `chrono_tool_invocation_outcome_total` (counter, by outcome)
- `chrono_conversation_messages_total{guard_action}` (counter)
- `chrono_conversation_quota_exceeded_total` (counter)
- `sli:chrono_api_availability:ratio_rate28d` (recording rule, derived)

Pair with the burn-rate alerts in `k8s/addons/observability-slo/alerts.yaml`.

## When to re-measure

Re-run the `ramp` profile against staging and update the table at the top
when any of these changes:

1. Backend pod CPU/memory request changes
2. PostgreSQL or Redis instance class changes
3. LLM provider or model changes
4. Major release (any quarter boundary; CHANGELOG marks breaking changes)

If a change moves the sustained RPS by more than 15% in either direction,
update the customer-facing SLA worksheet in `docs/sales/sla-template.md`
(if present) and notify the SRE channel.

## Failure modes worth modeling

These are the loads we deliberately verify the system survives. The
perf scenarios cover the first three; the rest are runbook-only.

| Failure mode | Scenario | Expected behaviour |
| ------------ | -------- | ------------------ |
| Sustained 1.5× peak | `k6-conversation` `soak` | 0 errors, p95 unchanged |
| Burst 5× peak for 60 s | `k6-conversation` `ramp` end | brief p95 spike, recovers ≤ 30 s |
| Tenant DDoS one route | `k6-portability-export` `burst` | 429s for offender, other tenants unaffected |
| LLM provider 30% slow | (manual; inject latency) | quota_exceeded counter rises, degrade message returned |
| PostgreSQL primary failover | (chaos; outside k6) | < 30 s downtime, no data loss (synchronous repl) |

## Owners

The perf suite is owned by the SRE team; capacity planning numbers are
co-owned with the platform team. Significant scaling decisions
(adding read replicas, sharding, multi-region) require an ADR.
