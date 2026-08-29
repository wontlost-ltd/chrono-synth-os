#!/usr/bin/env bash
# 零-LLM 内核纯度门的**自测**（审计 #410 / #430）。
#
# 为什么必须有自测：审计 #430 发现 12 个门禁脚本只有 2 个有自测，而本轮
# **出缺陷的三个门恰好全部无自测** —— 门自身逻辑退化（正则写错、退出码吞没、
# 外部依赖缺失）没有任何东西会发现，门永远打印 ✓。
#
# 本自测的判据：对每个「应当被拦截」的样例，门必须**非零退出**；
# 对干净样例，门必须**零退出**。样例写进临时 kernel 子目录，跑完即删。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="${ROOT_DIR}/scripts/check-forbidden-imports.sh"
PROBE_DIR="${ROOT_DIR}/packages/kernel/src/__gate_selftest__"
FAILURES=0

cleanup() { rm -rf "${PROBE_DIR}"; }
trap cleanup EXIT

run_case() {
  local name="$1" expect="$2" content="$3"
  rm -rf "${PROBE_DIR}"; mkdir -p "${PROBE_DIR}"
  printf '%s\n' "${content}" > "${PROBE_DIR}/probe.ts"
  bash "${GATE}" >/dev/null 2>&1
  local rc=$?
  rm -rf "${PROBE_DIR}"
  # ⚠️ RC=2 是**基础设施错误**（缺 rg / 坏正则），不是「检出违规」。
  # 若把它当作 block 成功，自测会在扫描器根本没跑的情况下报绿 ——
  # CI 实测正是如此：11 条 block「全过」而 3 条对照暴露真因（RC 全是 2）。
  # 故 block 只接受 RC=1（真检出），RC=2 一律判失败并点名。
  if [[ ${rc} -ge 2 ]]; then
    printf '  ✗ %s：门以基础设施错误退出（RC=%d，非「检出违规」）——扫描器可能未安装\n' "${name}" "${rc}" >&2
    FAILURES=$((FAILURES + 1))
  elif [[ "${expect}" == "block" && ${rc} -eq 0 ]]; then
    printf '  ✗ %s：应被拦截，实际放行（RC=0）\n' "${name}" >&2
    FAILURES=$((FAILURES + 1))
  elif [[ "${expect}" == "pass" && ${rc} -ne 0 ]]; then
    printf '  ✗ %s：应放行，实际拦截（RC=%d）\n' "${name}" "${rc}" >&2
    FAILURES=$((FAILURES + 1))
  else
    printf '  ✓ %s\n' "${name}"
  fi
}

printf '零-LLM 内核纯度门自测：\n'

# —— 审计 #410a 直接对应的漏检项（修复前这些全部放行）——
run_case '裸 node 内建导入（不带 node: 前缀）' block \
  "import { readFileSync } from 'fs';
export const x = readFileSync;"

run_case '裸 crypto 导入' block \
  "import { createHash } from 'crypto';
export const h = createHash;"

run_case 'OpenAI SDK 导入' block \
  "import OpenAI from 'openai';
export const c = OpenAI;"

run_case 'Anthropic SDK 导入' block \
  "import Anthropic from '@anthropic-ai/sdk';
export const c = Anthropic;"

run_case '网络调用 fetch()' block \
  "export async function go(): Promise<unknown> { return (await fetch('https://x')).json(); }"

run_case '不可注入随机源 Math.random()' block \
  "export function pick(): number { return Math.random(); }"

run_case '不可注入时钟 Date.now()' block \
  "export function stamp(): number { return Date.now(); }"

run_case 'new Date()' block \
  "export function stamp(): Date { return new Date(); }"

# —— 既有规则仍须有效 ——
run_case 'node: 前缀导入' block \
  "import { readFile } from 'node:fs/promises';
export const f = readFile;"

run_case 'process.env' block \
  "export const k = process.env.SECRET;"

run_case '跨层导入 ../storage/' block \
  "import { x } from '../storage/thing.js';
export const y = x;"

# —— 对照组：干净代码必须放行（否则门变成噪音，会被人绕过）——
run_case '纯确定性代码（对照，应放行）' pass \
  "export function add(a: number, b: number): number { return a + b; }"

run_case '注释里提到 Date.now 不算违规（对照，应放行）' pass \
  "/* 说明：此处不得使用 Date.now()，时钟必须注入。 */
export function add(a: number, b: number): number { return a + b; }"

run_case '类型字面量含 openai 不算导入（对照，应放行）' pass \
  "export type Provider = 'openai' | 'anthropic' | 'mock';"

if [[ ${FAILURES} -gt 0 ]]; then
  printf '\n✗ 门禁自测失败：%d 个用例不符合预期。门本身已失效，修好它再谈扫描结果。\n' "${FAILURES}" >&2
  exit 1
fi
printf '✓ 门禁自测通过（%s）\n' '拦截项与对照项均符合预期'
