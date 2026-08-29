#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS=0
NODE_BUILTIN="['\"]node:|['\"](fs|path|crypto|buffer|util|stream|events|url|os|http|https|net|tls|dns|zlib|child_process|cluster|worker_threads|timers|readline|assert|v8|vm|perf_hooks|async_hooks|diagnostics_channel)['\"]"

# ⚠️ 审计 #410b：rg 是**未声明的外部依赖**，CI 里从未安装（`grep -rn ripgrep .github/` 为空）。
# 此前 `matches="$(rg ... || true)"` 会把 rg 的失败（含 127 command-not-found）一并吞掉，
# matches 为空 → 判定「无违规」→ 退出 0。实测：同一个违规文件，有 rg 时 RC=1、
# `PATH=/usr/bin:/bin` 时 RC=0，而「无违规」也是 RC=0 —— 两种绿无法区分。
# 该门是 kernel/contracts/sync-engine/data-plane/design-tokens **五个包**纯度的唯一守卫，
# 静默失效等于零-LLM 内核铁律无人看守。故此处 fail-closed。
if ! command -v rg >/dev/null 2>&1; then
  printf 'FATAL: ripgrep (rg) not found — 该门依赖它做模式匹配。\n' >&2
  printf '安装：brew install ripgrep / apt-get install ripgrep\n' >&2
  printf '拒绝在缺少扫描器时报告「通过」（fail-closed）。\n' >&2
  exit 2
fi

check_matches() {
  local label="$1"
  local target_dir="$2"
  shift 2

  if [[ ! -d "${target_dir}" ]]; then
    return 0
  fi

  local matches rc
  # rg 退出码：0=有匹配、1=无匹配、≥2=真错误（坏正则/读不了文件等）。
  # 只把 1 当作「无违规」，≥2 一律 fail-closed —— 不再用 `|| true` 无差别吞掉。
  set +e
  matches="$(rg -n --glob '*.ts' --glob '!*.test.ts' "$@" "${target_dir}")"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    printf 'FATAL: rg 扫描 %s 时出错（退出码 %d），拒绝报告通过。\n' "${label}" "${rc}" >&2
    exit 2
  fi
  if [[ -n "${matches}" ]]; then
    printf 'Forbidden import check failed for %s\n' "${label}" >&2
    printf '%s\n' "${matches}" >&2
    STATUS=1
  fi
}

# ⚠️ 审计 #410a：kernel 分支此前只匹配 `node:` **前缀**导入，**裸** `fs`/`crypto`
# 等不在模式内（`NODE_BUILTIN` 只给了 contracts/sync-engine 用，唯独没给 kernel）；
# 且全脚本没有任何 fetch / Math.random / Date.now / LLM SDK 的规则。
# 实测：一个同时含 `import {readFileSync} from 'fs'`、`import OpenAI from 'openai'`、
# `await fetch(...)`、`Math.random()`、`Date.now()` 的合成 kernel 文件 —— 门 **退出 0**。
#
# 这三类正是「零-LLM 确定性内核」铁律的实质内容：
#   ① 不碰宿主运行时（可移植）② 不联网/不调 LLM ③ 不用不可注入的时钟与随机源。
check_matches \
  "packages/kernel" \
  "${ROOT_DIR}/packages/kernel/src" \
  -e "${NODE_BUILTIN}" \
  -e "process\\.env" \
  -e "\\bBuffer[[:space:]]*(\\.|\\(|\\[)" \
  -e "from ['\"](fastify|pg|node:sqlite)['\"]|import\\(['\"](fastify|pg|node:sqlite)['\"]" \
  -e "['\"]@fastify/" \
  -e "['\"]better-sqlite3['\"]" \
  -e "['\"]\\.\\./storage/" \
  -e "['\"]\\.\\./server/" \
  -e "['\"]\\.\\./multi-tenant/" \
  -e "^[[:space:]]*[^[:space:]*/].*\\bfetch[[:space:]]*\\(" \
  -e "^[[:space:]]*[^[:space:]*/].*\\bMath\\.random[[:space:]]*\\(" \
  -e "^[[:space:]]*[^[:space:]*/].*\\bDate\\.now[[:space:]]*\\(" \
  -e "^[[:space:]]*[^[:space:]*/].*\\bnew[[:space:]]+Date[[:space:]]*\\(" \
  -e "from ['\"](openai|@anthropic-ai/[a-z-]+|node-fetch|axios|undici|got)['\"]|import\\(['\"](openai|@anthropic-ai/[a-z-]+|node-fetch|axios|undici|got)['\"]"

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
