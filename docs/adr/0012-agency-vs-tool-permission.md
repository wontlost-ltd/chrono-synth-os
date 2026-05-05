# 0012 — `agency_authorizations` is separate from `tool_permissions`

**Status:** Accepted
**Date:** 2026-Q1
**Scope:** `src/agent/tool-permission-service.ts`, P3 admin tool layer

## Context

When the agent layer (P3) shipped, two superficially similar tables
appeared in the same migration:

- `tool_permissions(persona_id, tool_id, scope, constraints, ...)`
- `agency_authorizations(persona_id, principal_user_id, scope,
  scope_description, allowed_tools, denied_tools, ...)`

A reasonable engineering instinct is to merge them — both gate
"can persona X invoke tool Y?". Why have two?

## Decision

**They model different layers and are kept separate by design.**

| Aspect | `tool_permissions` | `agency_authorizations` |
| ------ | ------------------ | ----------------------- |
| Layer | Operational | Legal / regulatory |
| Granularity | One row per `(persona, tool)` | One row per `(persona, principalUser)` |
| Constraints | Rate caps, daily quotas, cost ceilings, allow/deny lists | Scope description (≥10 chars; legal evidence), suspended/revoked lifecycle |
| Lifecycle | Granted / expired / revoked | Active / suspended / resumed / revoked |
| Audience | Tenant admin tunes day-to-day | Compliance / legal review on creation |
| Persistence after revoke | Soft delete; visible | Soft delete; legal record kept ≥7y |

A tool call has to clear **both** layers to execute:

1. **Agency check first**: does this persona have an agency
   authorization from a real human user that covers this scope?
   If not → `denied_permission`. This is the AI-agent legal
   principle: a digital agent acts only with explicit principal
   authorization.
2. **Tool permission second**: does the granted authorization map
   to a `tool_permissions` row that lets this specific tool fire
   under the current quota / cost / time constraints? If not →
   `denied_quota` / `denied_circuit_open` / etc.

## Consequences

**Wins**

- Compliance review focuses on agency_authorizations only (legal
  scope, principal identity, evidence text). The ops surface —
  rate limits, cost caps — doesn't need legal sign-off every time
  it changes.
- Suspending an agency authorization revokes everything for that
  (persona, principal) pair without touching individual tool rows
  — single switch when a user offboards.
- Revoking a single tool grant ("turn off email.send for this
  persona") doesn't disturb the legal record.
- Different retention windows naturally apply to each table.

**Costs**

- Two writes on grant; two reads on every tool call. The reads
  are cached so the cost is amortized after the first tick per
  persona.
- More schema surface to keep mentally aligned. We mitigate with
  the table comparison above and an integration test that exercises
  both denial paths (`denied_permission` vs `denied_quota`).

## Alternatives considered

- **Merge into one table**: rejected — would force every per-tool
  rate-limit change through the legal-evidence schema, slowing
  iteration on operational knobs.
- **Skip agency, use tool_permissions only**: rejected — fails
  the agent-legal principle. Without an explicit principal-user
  authorization, the agent has no defensible chain of consent.

## Related

- [0005 — MCP tool protocol](0005-mcp-tool-protocol.md)
- `src/storage/migrations.ts` v067 (both tables together)
- `src/agent/tool-permission-service.ts`
