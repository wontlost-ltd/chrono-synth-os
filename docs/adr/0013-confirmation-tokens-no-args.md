# 0013 — Confirmation tokens don't persist arguments

**Status:** Accepted
**Date:** 2026-Q1
**Scope:** `src/agent/tool-permission-service.ts`, agent confirmation flow

## Context

When a high-risk tool (email.send, calendar.create, payment.transfer)
is invoked without a confirmation token, the kernel returns
`pending_confirmation` and creates a `confirmation_tokens` row. The
end user sees the pending invocation in the admin UI and can approve
or reject it. Approve → re-invoke the tool with the token → the
agent gets the result.

The natural design is to store the original arguments on the
confirmation row so approval is "click yes" with no data movement.
The natural design is also wrong for our threat model.

## Decision

**Confirmation rows store an `input_hash`, not the arguments
themselves.** The user must paste / re-supply the original arguments
when approving. Server-side flow on approval:

1. Re-hash the supplied arguments with the same SHA-256 algorithm.
2. Compare against `input_hash`.
3. Mismatch → reject the approval with a clear error.

The `tool_invocations` row stores `input_hash` permanently for audit;
the actual argument payload only lives in the request that initially
triggered the pending status, and is discarded as soon as the
function returns.

## Consequences

**Wins**

- The DB never holds tool-call arguments. PII (recipient emails,
  calendar invitee names, payment amounts) is bounded to the
  request lifetime.
- A leaked DB snapshot reveals what tools were attempted but not
  what they were trying to do. This is a real difference for
  exfiltration scenarios.
- Re-paste-on-approve is a soft form of two-person review — the
  user approving has to retrieve the original payload from the
  trigger context, which is a friction that catches "approve
  everything by default" mistakes.

**Costs**

- UX friction: the user has to find the original args. We mitigate
  via the runtime hint ("Look in your audit log / chat history for
  the JSON that triggered this") and structured `input_hash`
  display so the UI can verify the paste before submit.
- Some legitimate tools (large structured calendar events) have
  inconvenient payloads. We accept this — high-risk tools should
  be friction-bearing.

## Alternatives considered

- **Store args encrypted with per-token DEK**: rejected — moves
  the threat model from "storage compromise" to "key compromise"
  without buying real safety; encryption keys live in the same
  KMS that protects the rest of the data.
- **Time-bounded TTL on stored args (e.g. 60s)**: rejected — the
  product wants approvals to persist across the user being
  AFK. A 60s TTL just turns the "approve" flow into a race.

## Related

- [0005 — MCP tool protocol](0005-mcp-tool-protocol.md)
- [0012 — agency vs tool permission](0012-agency-vs-tool-permission.md)
- `src/agent/tool-permission-service.ts` (confirmation flow)
