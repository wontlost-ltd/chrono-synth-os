# 0025 — JSON over YAML for runtime config

**Status:** Accepted
**Date:** 2025-Q3
**Scope:** `src/config/`, `chrono-synth-deploy/k8s/configmap.yaml`

## Context

The runtime needs ~80 config knobs (DB driver, JWT enabled, rate
limit values, retention windows, OAuth client IDs, …). Two file
formats are reasonable:

- **YAML** — what most ops teams reach for; concise, supports
  comments.
- **JSON** — what most application code already produces and
  consumes; no comments, stricter syntax.

The runtime ingests config from environment variables and falls
back to file values (`config/default.json`, env-specific overlays).
The internal representation is a typed object validated by zod.

## Decision

**Config files are JSON.** `config/default.json` ships with the
binary; environment variables override per-key via the
`CHRONO_*` namespace.

Reasons specifically against YAML in this codebase:

1. **YAML's "Norway problem"** — `country: NO` parses as boolean
   `false`, not string `"NO"`. We have country / region keys.
   Hardcoded quoting rules are brittle.
2. **YAML version drift** — YAML 1.1 vs 1.2 differ on type coercion
   (octal `010`, sexagesimal). Different parsers behave differently.
   JSON has one version.
3. **No comments isn't a real loss** — config keys should be
   self-explanatory. Where they aren't, the schema (zod) carries
   the description. We document overrides in
   `docs/operations/configuration.md`, not inline.
4. **Diffability** — JSON pretty-printed is line-by-line diffable.
   YAML's optional-quoting and indent-as-syntax produces noisy
   diffs.

K8s ConfigMaps still use YAML because *Kubernetes itself* requires
it. The config payload inside the ConfigMap's `data` block is
JSON-as-string.

## Consequences

**Wins**

- One representation across in-memory (object), at-rest (JSON file),
  and over-the-wire (HTTP API). No format conversion.
- Schema validation with zod is straightforward — same shape input
  and output.
- Trivial to programmatically generate (CI builds, test fixtures).

**Costs**

- No comments. We document defaults inline in `src/config/schema.ts`
  via zod `.describe()`, and the schema is dumped by
  `npm run docs:config` for ops reference.
- Operators used to YAML pause briefly when editing the file. The
  pause is short.

## Alternatives considered

- **YAML**: rejected — see context.
- **TOML**: rejected — adds a third format alongside JSON-everywhere
  with no real win at our scale.
- **Pure env vars, no config file**: rejected — 80 env vars in a
  helm/kustomize patch are unreviewable.

## Related

- `src/config/schema.ts` — zod schema with descriptions
- `chrono-synth-deploy/k8s/base/backend/configmap.yaml`
- `docs/operations/configuration.md` (planned reference dump)
