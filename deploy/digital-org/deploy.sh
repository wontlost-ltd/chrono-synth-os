#!/usr/bin/env bash
#
# 数字员工组织·一键部署（ADR-0056 K6）——一条命令起一个完整的多原型数字员工组织。
#
# 做什么：
#   1. podman compose 起整栈（backend 自迁移 + 健康检查；prod 还含 postgres）；
#   2. 等 backend /healthz 就绪；
#   3. 在运行中的 backend 容器内跑 seed-org（落 7 名覆盖 4 原型的数字员工，各有独立认知内核）；
#   4. 打印组织摘要 + 访问入口。
#
# 用法（仓库根目录）：
#   bash deploy/digital-org/deploy.sh           # dev（SQLite，最快）
#   bash deploy/digital-org/deploy.sh prod      # prod（PostgreSQL + 队列）
#   bash deploy/digital-org/deploy.sh down      # 拆栈（含数据卷）
#
# 幂等：seed-org 可安全重跑（组织已存在复用 + 人格出生幂等）。重复执行 deploy.sh = 干净 no-op。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${SCRIPT_DIR}/podman-compose.yml"
MODE="${1:-dev}"

# 解析 compose 命令（podman compose 优先，回退 podman-compose / docker compose）。
if podman compose version >/dev/null 2>&1; then
  CC=(podman compose)
elif command -v podman-compose >/dev/null 2>&1; then
  CC=(podman-compose)
elif docker compose version >/dev/null 2>&1; then
  CC=(docker compose)
else
  echo "✗ 未找到 podman compose / podman-compose / docker compose，请先安装 podman。" >&2
  exit 1
fi

if [[ "${MODE}" == "down" ]]; then
  echo "▶ 拆除数字员工组织栈（含数据卷）…"
  "${CC[@]}" -f "${COMPOSE}" --profile dev --profile prod down -v
  echo "✓ 已拆除。"
  exit 0
fi

if [[ "${MODE}" == "prod" ]]; then
  PROFILE=(--profile prod)
  SERVICE="org-prod"
else
  MODE="dev"
  PROFILE=(--profile dev)
  SERVICE="org"
fi

echo "▶ 启动数字员工组织栈（模式=${MODE}）…"
"${CC[@]}" -f "${COMPOSE}" "${PROFILE[@]}" up -d --build

# 等 backend /healthz 就绪（最多 ~150s）。
echo "▶ 等待 backend 健康（/healthz）…"
READY=0
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:3000/healthz" >/dev/null 2>&1; then
    READY=1
    echo "✓ backend 已就绪（第 ${i} 次探测）。"
    break
  fi
  sleep 2.5
done
if [[ "${READY}" -ne 1 ]]; then
  echo "✗ backend 未在超时内就绪。最近日志：" >&2
  "${CC[@]}" -f "${COMPOSE}" "${PROFILE[@]}" logs --tail 40 "${SERVICE}" >&2 || true
  exit 1
fi

# 在运行中的 backend 容器内 seed 组织（同一个库；幂等可重跑）。
echo "▶ seed 数字员工组织（7 名 / 4 原型 / 各独立认知内核）…"
"${CC[@]}" -f "${COMPOSE}" "${PROFILE[@]}" exec -T "${SERVICE}" node dist/scripts/seed-org.js

cat <<'EOF'

──────────────────────────────────────────────────────────────
✓ 数字员工组织已就绪。
  · 一个 CEO（doer）领 研究(explorer)/质量(guardian)/数据(analyst) 三条线，各带一名 IC。
  · 每名员工有独立认知内核（零-LLM 确定性出生 + per-persona 自成长）。
  · backend API:   http://127.0.0.1:3000
    健康检查:      http://127.0.0.1:3000/healthz   /readyz
  · 重跑本脚本安全（幂等 no-op）。拆栈：bash deploy/digital-org/deploy.sh down
──────────────────────────────────────────────────────────────
EOF
