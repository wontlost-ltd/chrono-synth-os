#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS=0
NODE_BUILTIN="['\"]node:|['\"](fs|path|crypto|buffer|util|stream|events|url|os|http|https|net|tls|dns|zlib|child_process|cluster|worker_threads|timers|readline|assert|v8|vm|perf_hooks|async_hooks|diagnostics_channel)['\"]"

check_matches() {
  local label="$1"
  local target_dir="$2"
  shift 2

  if [[ ! -d "${target_dir}" ]]; then
    return 0
  fi

  local matches
  matches="$(rg -n --glob '*.ts' --glob '!*.test.ts' "$@" "${target_dir}" || true)"
  if [[ -n "${matches}" ]]; then
    printf 'Forbidden import check failed for %s\n' "${label}" >&2
    printf '%s\n' "${matches}" >&2
    STATUS=1
  fi
}

check_matches \
  "packages/kernel" \
  "${ROOT_DIR}/packages/kernel/src" \
  -e "${NODE_BUILTIN}" \
  -e "['\"]fastify['\"]|['\"]@fastify/" \
  -e "process\\.env|\\bBuffer\\b" \
  -e "['\"]better-sqlite3['\"]" \
  -e "['\"]pg['\"]" \
  -e "['\"]\\.\\./storage/" \
  -e "['\"]\\.\\./server/" \
  -e "['\"]\\.\\./multi-tenant/"

check_matches \
  "packages/contracts" \
  "${ROOT_DIR}/packages/contracts/src" \
  -e "${NODE_BUILTIN}" \
  -e "['\"]fastify['\"]|['\"]@fastify/" \
  -e "process\\.env|\\bBuffer\\b" \
  -e "['\"]better-sqlite3['\"]" \
  -e "['\"]pg['\"]"

check_matches \
  "packages/sync-engine" \
  "${ROOT_DIR}/packages/sync-engine/src" \
  -e "${NODE_BUILTIN}" \
  -e "['\"]fastify['\"]|['\"]@fastify/" \
  -e "process\\.env|\\bBuffer\\b" \
  -e "['\"]better-sqlite3['\"]" \
  -e "['\"]pg['\"]" \
  -e "['\"]\\.\\./storage/" \
  -e "['\"]\\.\\./server/" \
  -e "['\"]\\.\\./multi-tenant/"

check_matches \
  "packages/design-tokens" \
  "${ROOT_DIR}/packages/design-tokens/src" \
  -e "${NODE_BUILTIN}" \
  -e "process\\.env|\\bBuffer\\b"

check_matches \
  "packages/data-plane" \
  "${ROOT_DIR}/packages/data-plane/src" \
  -e "${NODE_BUILTIN}" \
  -e "['\"]fastify['\"]|['\"]@fastify/" \
  -e "process\\.env|\\bBuffer\\b" \
  -e "['\"]\\.\\./server/"

exit "${STATUS}"
