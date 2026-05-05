# 0005 — MCP protocol for the agent tool layer

**Status:** Accepted
**Date:** 2026-Q1
**Scope:** `src/agent/mcp-server.ts`, `src/agent/tools/*`

## Context

The agent layer (P3) needs to invoke tools — web search, calendar, email,
internal RPCs — on behalf of a persona. Three options were on the table:

1. **Bespoke RPC**: define an internal interface, generate clients from it.
2. **OpenAPI**: model each tool as a REST endpoint, codegen from a spec.
3. **Model Context Protocol (MCP)**: the open Anthropic-led standard for
   exposing tools to LLMs, with a reference TypeScript SDK.

The decision driver was: *who else can drive these tools?* If only our own
agent runtime, bespoke RPC is fine. If we want third-party assistants
(Claude Desktop, OpenAI tool calling, future inference providers) to call
our tools too, we need an interop format.

## Decision

**Adopt MCP as the tool protocol.** The chrono-synth-os process embeds an
MCP server that exposes the same five internal tools (`web_search`,
`calendar.create`, `calendar.list`, `email.send`, `internal_query`) over
stdio + SSE. The server is the single source of truth for tool surface;
the in-process agent uses an in-memory MCP client that bypasses
serialization but speaks the same schema.

Permission gating, confirmation tokens, and audit logging happen *inside*
the server, not in the call site. Any future MCP-capable assistant gets
the same enforcement for free.

## Consequences

**Wins**

- Single tool surface for in-process agents and external MCP clients.
- Schema discovery is built in (`tools/list`); UI surfaces it without any
  hand-maintained tool catalog.
- The protocol's confirmation flow (server returns `pending_confirmation`,
  client re-invokes with token) maps cleanly onto the existing
  high-risk-tool gating.
- Tool tests run against the MCP server, not the in-process API — they
  exercise the same code path that production third-party clients hit.

**Costs**

- We ship the MCP TS SDK as a runtime dependency in adapters. Acceptable —
  the SDK is small (~70 KB) and only loaded by adapters, not the kernel
  ([ADR 0001](0001-kernel-zero-runtime-deps.md)).
- MCP is young; the spec moves. We pin to a known-good version and watch
  the changelog. The SDK's `Tool` schema has changed twice already; both
  migrations were ~10-line patches.

## Alternatives considered

- **Bespoke RPC**: rejected — locks out third-party callers. Even if we
  never have one, the schema discovery story is too good to give up.
- **OpenAPI**: rejected — heavyweight for in-process calls, and tool
  invocation patterns (long-running, confirmation, structured errors)
  don't fit neatly into REST verbs.

## Related

- `src/agent/mcp-server.ts`
- [0013 — Confirmation tokens don't persist arguments](#) (planned)
- `.claude/plan/enterprise-readiness-2026.md` § P3
