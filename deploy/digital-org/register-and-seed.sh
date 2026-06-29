#!/usr/bin/env bash
#
# 注册 admin + 用其租户 seed 数字员工组织（便捷脚本）。
#
# 背景：register 注册的 admin 是**独立新租户**，而 seed-org 默认落 default 租户——两者不同租户，
# 新 admin 登录后看 /workforce/viz 会是空的。本脚本把两步对齐：注册 admin → 拿其 tenantId →
# 用该 tenantId seed 组织，让 admin 登录即看到组织。
#
# 前置：栈已起且 backend /healthz 就绪（先跑 deploy.sh）。需要 curl + jq。
#
# 用法（仓库根目录）：
#   bash deploy/digital-org/register-and-seed.sh                          # 默认凭据/orgId
#   ADMIN_EMAIL=me@co.com ADMIN_PASSWORD=secret123 ORG_ID=acme bash deploy/digital-org/register-and-seed.sh
#
# 幂等：admin 已注册则改走 login；seed 幂等（组织已存在复用）。

set -euo pipefail

API="${API_BASE_URL:-http://127.0.0.1:3000}"
EMAIL="${ADMIN_EMAIL:-admin@chrono.local}"
PASSWORD="${ADMIN_PASSWORD:-password123}"
ORG_ID="${ORG_ID:-chrono-digital-org}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${SCRIPT_DIR}/podman-compose.yml"
MODE="${1:-dev}"
if [[ "${MODE}" == "prod" ]]; then PROFILE=(--profile prod); SERVICE="org-prod"; else PROFILE=(--profile dev); SERVICE="org"; fi

if ! command -v jq >/dev/null 2>&1; then
  echo "✗ 需要 jq（解析 register 响应）。请先安装 jq。" >&2
  exit 1
fi
# 解析 compose 命令（与 deploy.sh 同款）。
if podman compose version >/dev/null 2>&1; then CC=(podman compose)
elif command -v podman-compose >/dev/null 2>&1; then CC=(podman-compose)
elif docker compose version >/dev/null 2>&1; then CC=(docker compose)
else echo "✗ 未找到 podman/docker compose。" >&2; exit 1; fi

echo "▶ 注册 admin（${EMAIL}）…"
REG=$(curl -s -X POST "${API}/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")
TENANT_ID=$(echo "${REG}" | jq -r '.data.tenantId // empty')

if [[ -z "${TENANT_ID}" ]]; then
  # 已注册过？改走 login 拿 tenantId。
  echo "  （register 未返回 tenantId，尝试 login——可能已注册过）"
  LOGIN=$(curl -s -X POST "${API}/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")
  TENANT_ID=$(echo "${LOGIN}" | jq -r '.data.tenantId // empty')
fi
if [[ -z "${TENANT_ID}" ]]; then
  echo "✗ 拿不到 tenantId。register 响应：${REG}" >&2
  exit 1
fi
echo "✓ admin tenantId = ${TENANT_ID}"

echo "▶ 用该租户 seed 数字员工组织（org=${ORG_ID}）…"
"${CC[@]}" -f "${COMPOSE}" "${PROFILE[@]}" exec -T \
  -e "CHRONO_SEED_TENANT_ID=${TENANT_ID}" -e "CHRONO_SEED_ORG_ID=${ORG_ID}" \
  "${SERVICE}" node dist/scripts/seed-org.js

cat <<EOF

──────────────────────────────────────────────────────────────
✓ admin + 数字员工组织已对齐。
  · 登录:   ${EMAIL} / ${PASSWORD}
  · 租户:   ${TENANT_ID}
  · 组织:   ${ORG_ID}（7 名 / 4 原型 / 各独立认知内核）
  · 可视化: 控制台登录后访问 /workforce/viz，输入组织 ID「${ORG_ID}」
  · 自助:   也可在 /workforce/viz 的「管理」里建组织 / 招数字员工
──────────────────────────────────────────────────────────────
EOF
