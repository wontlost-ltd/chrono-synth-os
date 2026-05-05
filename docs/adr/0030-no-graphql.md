# 0030 — No GraphQL API

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** API surface (`src/server/routes/*`)

## Context

The fashionable API choice for new SaaS products is GraphQL.
Customers occasionally ask for it. The argument: clients fetch
exactly what they need, schema is self-documenting, fewer round
trips for nested data.

The actual access patterns we observe are:

1. List N items, then click through to one detail page.
2. Submit a write, get a confirmation.
3. Subscribe to event stream (SSE / WebSocket).

For (1), pagination is a 1-round-trip REST `GET`. For (2), REST
`POST` is one round trip. For (3), WebSocket / SSE is the right
tool — neither REST nor GraphQL. We don't have a use case where
deep nested fetches with custom shapes save meaningful work.

## Decision

**REST + JSON, with two transports for streaming**: SSE for
server-push events, WebSocket for bidirectional flows.
The MCP server ([ADR 0005](0005-mcp-tool-protocol.md)) is the only
"programmable" API surface and uses JSON-RPC, not GraphQL.

REST conventions:

- Resource paths under `/api/v1/...`, versioned in the path.
- Standard verbs (GET / POST / PUT / DELETE).
- Cursor pagination for lists (`?cursor=...&limit=...`).
- Error envelope: `{ error: { code, message } }` (consistent with
  ChronoError).

## Consequences

**Wins**

- One mental model for everyone reading the code: it's just HTTP.
  No DataLoader N+1 traps, no resolver tree, no schema-stitching
  for federated services.
- Caching is straightforward — HTTP caching layers (CDN, browser)
  work by URL. GraphQL bypasses HTTP caching by collapsing all
  queries into one POST.
- Observability is per-route. Each endpoint has its own SLO band
  and metrics.
- API stability: deprecating an endpoint is a clear contract;
  GraphQL field deprecations are softer and customers don't
  notice them.

**Costs**

- Customers fetching deeply nested data make multiple round trips.
  We mitigate with a few intentionally-aggregating endpoints (e.g.,
  `/api/v1/persona-core/:id/full` returns persona + values +
  recent memories in one shot).
- Some clients ask for GraphQL specifically. We tell them the API
  surface is REST and offer the OpenAPI spec for codegen.

## Alternatives considered

- **GraphQL primary API**: rejected — see context.
- **GraphQL alongside REST**: rejected — two parallel APIs is a
  documentation and consistency nightmare.
- **gRPC**: rejected — browser support is via gRPC-Web, which
  adds infra (Envoy) for marginal benefit. WebSocket + JSON-RPC
  covers the streaming case.

## Related

- [0005 — MCP tool protocol](0005-mcp-tool-protocol.md)
- `docs/api.md`
- `src/server/routes/` (every endpoint is REST + JSON)
