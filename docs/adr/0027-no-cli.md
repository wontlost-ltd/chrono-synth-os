# 0027 — We don't ship a CLI

**Status:** Accepted
**Date:** 2025-Q4
**Scope:** product surface

## Context

Several backlog items have asked for "a `chrono` CLI" — provision a
persona, run a simulation, export a portability pack, manage tool
permissions, etc. The argument: CLIs are expected for developer-
facing products and they make automation easier.

The case for not shipping one is structural:

1. **Everything the CLI would do already exists as an API.** The
   admin-tools surface, the privacy-export endpoints, the
   conversation submit — all REST, all documented in `docs/api.md`.
2. **A CLI doubles the surface area to maintain.** New endpoints
   need a CLI command; deprecations need CLI deprecation cycles.
3. **CLI auth is a separate problem.** Browser cookies vs PAT vs
   API key vs SSO — every CLI customer has a different working
   environment.

## Decision

**No first-party CLI.** Instead, we ship and document:

- **Stable HTTP API** with OpenAPI schemas exported per release.
- **`curl` recipe section** in `docs/api.md` for the most common
  flows (login, list personas, run a simulation, export a pack).
- **MCP server** — the agent layer ([ADR 0005](0005-mcp-tool-protocol.md))
  is itself a programmable surface; teams who want CLI-style scripting
  can attach to MCP from Claude Desktop, OpenAI, etc.

For users who genuinely want a shell binary, we direct them at one
of two community wrappers (linked in README) and offer to PR
bug fixes upstream.

## Consequences

**Wins**

- One source of truth: HTTP/MCP. CLI users build atop the same
  contract as everyone else.
- API stability discipline tightens — there's no "internal CLI"
  shortcut to deviate from documented endpoints.
- Saves ~1 FTE of CLI maintenance (versioning, release engineering,
  Homebrew/scoop/apt distribution, shell completions).

**Costs**

- "Where's the `chrono` CLI?" is a recurring question; answered in
  the FAQ.
- A few common workflows (bulk-import knowledge sources, batch
  persona ops) are clunky over curl. We mitigate with the bulk
  endpoints (P3) where the API itself is shaped for batch use.

## Alternatives considered

- **Ship a CLI**: rejected — see context.
- **Generate a CLI from the OpenAPI schema**: rejected — generated
  CLIs are typically painful (every endpoint becomes a flat
  command, no curated UX). If we ever do this, it's a separate
  product ADR.

## Related

- [0005 — MCP tool protocol](0005-mcp-tool-protocol.md)
- `docs/api.md` (curl recipes)
