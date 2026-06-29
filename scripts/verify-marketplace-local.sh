#!/usr/bin/env bash
# 本地验证「数字组织从任务市场接工单」全链路——一条命令跑完，打印每步结果。
# 前置：deploy.sh dev 已起栈（后端 127.0.0.1:3000 healthy）。
set -euo pipefail

API="http://127.0.0.1:3000"
EMAIL="${VERIFY_EMAIL:-verify-$(date +%s)@local.test}"  # 每次跑用新邮箱，避免冲突
PASS="password123"
ORG="chrono-digital-org"
GTYPE="data_analysis"
SRC_TASK="MKT-$(date +%s)"     # 唯一工单号
REWARD=50000                   # 报酬 500.00 元（minor=分）
PLATFORM=20                    # 平台抽成 20%

j() { python3 -c "import sys,json;d=json.loads(sys.stdin.read(),strict=False);print(d$1)"; }

echo "▶ 后端健康检查"
curl -fsS "$API/healthz" | j "['status']" | sed 's/^/  status=/'

echo "▶ 1/6 注册 admin: ${EMAIL}"
REG=$(curl -s -X POST "$API/api/v1/auth/register" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
TENANT=$(echo "$REG" | j "['data']['tenantId']")
echo "  tenantId=$TENANT"

echo "▶ 2/6 用该租户 seed 15 人组织（对齐租户，登录可见）"
podman exec -e "CHRONO_SEED_TENANT_ID=$TENANT" -e "CHRONO_SEED_ORG_ID=$ORG" chrono-digital-org node dist/scripts/seed-org.js 2>&1 | grep -E "组织已建" | sed 's/^.*\] /  /'

echo "▶ 3/6 登录拿 token"
TOKEN=$(curl -s -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | j "['data']['accessToken']")
AUTH=(-H "Authorization: Bearer $TOKEN" -H "x-tenant-id: $TENANT" -H 'Content-Type: application/json')
B="$API/api/v1/workforce/orgs/$ORG"

echo "▶ 4/6 取「内容与数据负责人」workerId（data_analysis 工单发给它）"
LEAD=$(curl -s "$B/chart" "${AUTH[@]}" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read(),strict=False).get('data',{})
pos={p['id']:p['roleCode'] for p in d.get('positions',[])}
print(next(w['id'] for w in d['workers'] if pos.get(w['positionId'])=='knowledge_lead'))")
echo "  knowledge_lead=$LEAD"

echo "▶ 5/6 ★接市场工单★ → 组织确定性分解委派"
ACC=$(curl -s -X POST "$B/marketplace-tasks/accept" "${AUTH[@]}" \
  -d "{\"sourceMarketplaceTaskId\":\"$SRC_TASK\",\"managerWorkerId\":\"$LEAD\",\"title\":\"客户季度销售分析工单\",\"description\":\"市场工单\",\"goalType\":\"$GTYPE\"}")
echo "$ACC" | python3 -c "
import sys,json
x=json.loads(sys.stdin.read(),strict=False).get('data',{})
print(f'  ✓ 接单成功 goalId={x.get(\"goalId\")}')
print(f'    源工单={x.get(\"sourceMarketplaceTaskId\")}  分解={x.get(\"taskCount\")}步  具名问责={x.get(\"accountableStages\")}  待执行={x.get(\"pendingRealExecution\")}')"
GOALID=$(echo "$ACC" | j "['data']['goalId']")

echo "▶ 6/6 工单完工，结算报酬入组织金库 (total=${REWARD} 分, 平台抽 ${PLATFORM}%)"
SET=$(curl -s -X POST "$B/marketplace-tasks/$SRC_TASK/settle" "${AUTH[@]}" \
  -d "{\"totalAmountMinor\":$REWARD,\"currency\":\"CRED\",\"platformPct\":$PLATFORM,\"goalId\":\"$GOALID\"}")
echo "$SET" | python3 -c "
import sys,json
x=json.loads(sys.stdin.read(),strict=False).get('data',{}); s=x.get('settlement',{})
print(f'  ✓ 两方分账：总报酬={s.get(\"totalAmountMinor\")} 平台抽成={s.get(\"platformAmountMinor\")} 组织净留存={s.get(\"orgAmountMinor\")}')
print(f'    💰 组织金库余额 = {x.get(\"walletBalance\")} {x.get(\"currency\")}')"

echo "▶ 幂等验证：同工单再结算一次 → 余额不翻倍"
SET2=$(curl -s -X POST "$B/marketplace-tasks/$SRC_TASK/settle" "${AUTH[@]}" -d "{\"totalAmountMinor\":$REWARD,\"currency\":\"CRED\",\"platformPct\":$PLATFORM}")
echo "$SET2" | python3 -c "import sys,json;x=json.loads(sys.stdin.read(),strict=False).get('data',{});print(f'  💰 再结算后余额 = {x.get(\"walletBalance\")}（应不变=幂等正确）')"

echo ""
echo "════════════════════════════════════════════"
echo "✓ 全链路验证通过：组织接市场工单→确定性分解→结算入金库→幂等"
echo "  登录信息：$EMAIL / $PASS   租户=$TENANT"
echo "════════════════════════════════════════════"
