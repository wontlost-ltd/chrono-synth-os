# 0037 — SSE for one-way push, WebSocket for bidirectional only

**Status:** Accepted
**Date:** 2026-Q2 (avatar-cross-device delivery)
**Scope:** `src/server/plugins/websocket.ts`, `src/server/routes/sse.ts`

## Context

Chrono Synth has two real-time transports running in parallel:

- **WebSocket** at `WS /ws` (`src/server/plugins/websocket.ts`) —
  shipped originally for the dashboard's real-time event feed, used
  by the SPA + the desktop app.
- **SSE** at `GET /api/v1/events/stream` (`src/server/routes/sse.ts`)
  — added later (avatar-cross-device plan) for CLI / mobile / IoT
  clients that don't want a full WebSocket implementation.

Both push the same set of events (defined in `VALID_EVENTS`). Both
respect the same tenant isolation. Both use the same persisted
event-buffer + replay-from-seq mechanism.

A new engineer asks: "We have two ways to push events. Which one
should I use? When?" The answer is non-obvious from the code.

## Decision

**SSE is the default for one-way server-to-client push. WebSocket
is reserved for bidirectional traffic.**

Specifically:

- New clients that just listen for events (CLI tools, mobile push
  bridges, embedded devices, scripts) → **SSE**.
- Clients that need to also send commands over the same connection
  (the SPA's collaborative simulation editor, future co-editing,
  RPC-style command channels) → **WebSocket**.

Both transports share infrastructure:

- `VALID_EVENTS` set is exported from `websocket.ts` and reused by
  `sse.ts` to validate subscriptions.
- `bufferEvent()` / `getPersistedEventsSince()` / `getBufferedEventsSince()`
  / `getOldestBufferedSeq()` / `currentGlobalSeq()` are shared
  helpers; SSE imports them directly.
- Both run the same authentication path (JWT validation + tenant
  binding).

## Consequences

**Wins**

- CLI / mobile / IoT clients don't need a WebSocket library.
  `curl -N` works for SSE; the fetch API streams it natively in any
  modern environment.
- SSE goes through HTTP-aware infrastructure (CDNs, reverse proxies,
  corporate firewalls) without protocol upgrade negotiation. Clients
  behind aggressive HTTP proxies that strip Upgrade headers still
  get events.
- Auto-reconnect is built into the `EventSource` browser API.
  Re-implementing it on top of `WebSocket` is non-trivial.
- Two transports backed by one event source = one set of subscriber
  semantics to reason about. No "WebSocket clients see X but SSE
  clients see Y" drift.

**Costs**

- Two transports = two security review surfaces. Both must enforce
  tenant isolation, both must validate JWT, both must apply
  rate-limit middleware. Mitigated by shared infra in `websocket.ts`.
- SSE is one-way; clients that decide they need to send commands
  later have to switch transports, not "upgrade" the connection.
  This is fine because the choice is intentional (above) — you
  pick SSE only when you don't need send.
- HTTP/2 servers must allow multiple concurrent SSE streams per
  origin. Modern infra handles this fine, but very old proxies
  (HTTP/1.1 only, max-2-conn-per-origin) can starve.

## Alternatives considered

- **WebSocket-only:** rejected. Forces every CLI / mobile / scripted
  client to ship a WS library and re-implement auto-reconnect, just
  to read events. The avatar-cross-device plan explicitly listed CLI
  and mobile-bridge clients as targets; SSE is the right shape.
- **SSE-only (drop WebSocket):** rejected. The SPA's existing
  collaborative editing / draft-syncing features need bidirectional
  real-time RPC over the same connection. Replacing WS with
  SSE+POST means two TCP connections per client, race conditions on
  ordering, and no flow control on the client→server direction.
- **gRPC streaming:** rejected at the transport layer for the same
  reason as ADR-0030 (no GraphQL): adds a binary protocol that's
  hostile to debug-via-curl, hostile to the same browser/firewall
  stack, and adds a code-generation step.
- **Long polling:** rejected. The latency floor (≥1 RTT per event)
  is unacceptable for the live dashboard.

## How to enforce going forward

- New event-push endpoints follow the rule above. If you find
  yourself building a "WebSocket route that only emits, never
  receives", convert it to SSE.
- Both transports MUST go through `VALID_EVENTS` validation.
  Adding a new system event requires extending the set in
  `websocket.ts`; SSE picks it up automatically.
- The shared `bufferEvent` / `currentGlobalSeq` helpers are the
  source of truth for replay semantics. Don't duplicate the buffer.
- When in doubt, default to SSE. Switching SSE → WebSocket later
  is easier than switching WebSocket → SSE (the latter requires
  client-side rework).

## Related

- [ADR-0030 — No GraphQL API](0030-no-graphql.md) — same "stay HTTP-friendly" instinct
- `src/server/plugins/websocket.ts` — authoritative event source + helpers
- `src/server/routes/sse.ts` — SSE consumer of the same buffer
- `src/types/avatar-session.ts` — `AvatarSessionTransport` enum reflecting this duality
- `.claude/plan/avatar-cross-device.md` — original SSE rationale
