#!/usr/bin/env bash
# 本地验证「双边工单市场」全链路（ADR-0058）——org 竞标接单→发布者确认委派→org 执行→验收结算入金库。
# 前置：deploy.sh dev 已起栈（后端 127.0.0.1:3000 healthy）。
set -euo pipefail

API="http://127.0.0.1:3000"
EMAIL="bid-$(date +%s)@local.test"
PASS="password123"
ORG="chrono-digital-org"
TASK="MKTBID-$(date +%s)"

j() { python3 -c "import sys,json;d=json.loads(sys.stdin.read(),strict=False);print(d$1)"; }

echo "▶ 1/8 注册 admin (${EMAIL}) — 既是发布者也是 org admin（同租户演示）"
REG=$(curl -s -X POST "$API/api/v1/auth/register" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
TENANT=$(echo "$REG" | j "['data']['tenantId']")
TOKEN=$(curl -s -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | j "['data']['accessToken']")
# 发布者 sub = JWT payload.sub
PUBSUB=$(python3 -c "import base64,json,sys;p='$TOKEN'.split('.')[1];p+='='*(-len(p)%4);print(json.loads(base64.urlsafe_b64decode(p))['sub'])")
echo "  tenant=$TENANT  publisherSub=$PUBSUB"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "x-tenant-id: $TENANT" -H 'Content-Type: application/json')

echo "▶ 2/8 用该租户 seed 15 人组织"
podman exec -e "CHRONO_SEED_TENANT_ID=$TENANT" -e "CHRONO_SEED_ORG_ID=$ORG" chrono-digital-org node dist/scripts/seed-org.js 2>&1 | grep -E "组织已建" | sed 's/^.*\] /  /'

echo "▶ 3/8 发布者发布一个工单（HTTP publish，publisher=登录 admin）"
PUB=$(curl -s -X POST "$API/api/v1/marketplace/tasks" "${AUTH[@]}" -d '{"title":"为客户写一篇产品稿","description":"市场工单：内容创作","category":"writing","reward":500,"currency":"CRED"}')
TASK=$(echo "$PUB" | j "['data']['id']")
echo "  工单已发布：$TASK (报酬 500 CRED)"

B="$API/api/v1/workforce/orgs/$ORG/bids"

echo "▶ 4/8 ★组织领取工单★（apply，登记意向不触发执行）"
curl -s -X POST "$B/apply" "${AUTH[@]}" -d "{\"taskId\":\"$TASK\"}" | python3 -c "import sys,json;x=json.loads(sys.stdin.read(),strict=False).get('data',{});print(f'  ✓ 已领取，申请状态={x.get(\"status\")} 排序分={x.get(\"rankingScore\")}')"

echo "▶ 5/8 发布者看申请者列表"
curl -s "$B/tasks/$TASK/applicants" "${AUTH[@]}" | python3 -c "import sys,json;d=json.loads(sys.stdin.read(),strict=False).get('data',[]);print(f'  申请者数={len(d)} → {[a[\"orgId\"] for a in d]}')"

echo "▶ 6/8 ★发布者确认委派给组织★（confirm-assign，工单 open→accepted）"
curl -s -X POST "$B/confirm-assign" "${AUTH[@]}" -d "{\"taskId\":\"$TASK\",\"orgId\":\"$ORG\"}" | python3 -c "import sys,json;x=json.loads(sys.stdin.read(),strict=False).get('data',{});print(f'  ✓ 已委派，指派状态={x.get(\"status\")}')"

echo "▶ 7/8 取「内容与数据负责人」+ ★组织启动执行★（start，runGoal 分解 content_piece）"
LEAD=$(curl -s "$API/api/v1/workforce/orgs/$ORG/chart" "${AUTH[@]}" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read(),strict=False).get('data',{})
pos={p['id']:p['roleCode'] for p in d.get('positions',[])}
print(next(w['id'] for w in d['workers'] if pos.get(w['positionId'])=='knowledge_lead'))")
curl -s -X POST "$B/start" "${AUTH[@]}" -d "{\"taskId\":\"$TASK\",\"managerWorkerId\":\"$LEAD\",\"goalType\":\"content_piece\"}" | python3 -c "import sys,json;x=json.loads(sys.stdin.read(),strict=False).get('data',{});print(f'  ✓ 启动分解：目标 taskCount={x.get(\"goal\",{}).get(\"taskCount\")} 指派状态={x.get(\"assignment\",{}).get(\"status\")}')"

echo "  组织提交完工（submit）"
curl -s -X POST "$B/submit" "${AUTH[@]}" -d "{\"taskId\":\"$TASK\"}" | python3 -c "import sys,json;x=json.loads(sys.stdin.read(),strict=False).get('data',{});print(f'  ✓ 已提交，指派状态={x.get(\"status\")}')"

echo "▶ 8/8 ★发布者验收并结算入组织金库★（accept，两方分账）"
curl -s -X POST "$B/accept" "${AUTH[@]}" -d "{\"taskId\":\"$TASK\",\"platformPct\":20}" | python3 -c "
import sys,json
x=json.loads(sys.stdin.read(),strict=False).get('data',{}); s=x.get('settlement') or {}
print(f'  ✓ 验收+结算：组织净留存={s.get(\"orgAmountMinor\")} 平台抽成={s.get(\"platformAmountMinor\")}')
print(f'  💰 组织金库余额 = {x.get(\"walletBalance\")} （500元报酬，抽20% → 净留存 400）')"

echo ""
echo "════════════════════════════════════════════"
echo "✓ 双边市场全链路通：发布→领取→确认委派→执行分解→提交→验收→结算入金库"
echo "  登录：$EMAIL / $PASS   前端 http://localhost:5173/workforce/marketplace"
echo "════════════════════════════════════════════"
