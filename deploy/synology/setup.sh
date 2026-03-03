#!/usr/bin/env bash
# ChronoSynthOS 群晖 NAS 一键部署脚本
# 实测环境：Pentium N3710 / 8GB / DSM 7.3 / volume2
# 前置要求：
#   - DSM 7.2+ 已安装 Container Manager
#   - SSH 已启用
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ── 前置检查 ──

if ! command -v docker &>/dev/null; then
  error "Docker 未安装。请在 DSM → 套件中心 安装 Container Manager。"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  error "Docker Compose 不可用。需要 Docker Compose v2（Container Manager 自带）。"
  exit 1
fi

# 检查内存
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_MEM_GB=$((TOTAL_MEM_KB / 1024 / 1024))
info "检测到内存: ${TOTAL_MEM_GB}GB"
if [ "$TOTAL_MEM_GB" -lt 6 ]; then
  warn "内存 ${TOTAL_MEM_GB}GB，完整部署建议 8GB+。可能遇到 OOM。"
fi

# 检查 CPU
CPU_MODEL=$(grep "model name" /proc/cpuinfo | head -1 | cut -d: -f2 | xargs)
info "CPU: $CPU_MODEL"

# 检查 AVX 支持
if ! grep -q " avx " /proc/cpuinfo; then
  warn "CPU 不支持 AVX 指令集。如果 Node 24 崩溃，改 .env 中 NODE_VERSION=22"
fi

# ── 环境配置 ──

if [ ! -f "$ENV_FILE" ]; then
  info "未找到 .env，从模板创建..."
  cp "$SCRIPT_DIR/.env.synology" "$ENV_FILE"

  # 自动生成密钥
  if command -v openssl &>/dev/null; then
    JWT_SECRET=$(openssl rand -hex 32)
    PG_PASS=$(openssl rand -hex 16)
    sed -i "s/CHRONO_JWT_SECRET=CHANGE-ME.*/CHRONO_JWT_SECRET=$JWT_SECRET/" "$ENV_FILE"
    sed -i "s/PG_PASSWORD=CHANGE-ME.*/PG_PASSWORD=$PG_PASS/" "$ENV_FILE"
    info "已自动生成 JWT_SECRET 和 PG_PASSWORD"
  else
    warn "请编辑 $ENV_FILE 修改以下密钥："
    warn "  - CHRONO_JWT_SECRET"
    warn "  - PG_PASSWORD"
    echo ""
    warn "修改完成后重新运行此脚本。"
    exit 0
  fi
fi

# 二次检查密钥
if grep -q "CHANGE-ME" "$ENV_FILE"; then
  error ".env 中仍包含默认密钥 (CHANGE-ME)，请先修改！"
  error "  vim $ENV_FILE"
  exit 1
fi

info "项目目录: $PROJECT_ROOT"
info "Compose:  $COMPOSE_FILE"
info "环境文件: $ENV_FILE"

# ── 构建 ──

NODE_VER=$(grep "^NODE_VERSION=" "$ENV_FILE" | cut -d= -f2 || echo "24")
info "Node.js 版本: ${NODE_VER}"
info "构建镜像（N3710 首次构建约 10-15 分钟）..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build

# ── 快速验证 Node 是否能在此 CPU 上运行 ──

info "验证 Node ${NODE_VER} 在当前 CPU 上的兼容性..."
if ! docker run --rm "node:${NODE_VER}-slim" node -e "console.log('ok')" 2>/dev/null; then
  error "Node ${NODE_VER} 在此 CPU 上无法运行 (可能缺少 AVX)！"
  error "请修改 $ENV_FILE 中 NODE_VERSION=22，然后重新运行此脚本。"
  exit 1
fi
info "Node ${NODE_VER} 兼容性验证通过"

# ── 启动 ──

info "启动所有服务..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

# ── 等待健康检查 ──

info "等待服务就绪（N3710 首次启动可能较慢）..."
MAX_WAIT=180
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  HEALTH=$(docker inspect --format='{{.State.Health.Status}}' chrono-backend 2>/dev/null || echo "starting")
  if [ "$HEALTH" = "healthy" ]; then
    break
  fi
  sleep 5
  WAITED=$((WAITED + 5))
  echo -n "."
done
echo ""

if [ "$WAITED" -ge $MAX_WAIT ]; then
  warn "后端服务启动超时（${MAX_WAIT}s），查看日志："
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail=50 backend
  echo ""
  # 检查是否是 Illegal Instruction
  if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs backend 2>&1 | grep -qi "illegal instruction"; then
    error "检测到 'Illegal Instruction'！Node ${NODE_VER} 不兼容此 CPU。"
    error "修改 $ENV_FILE 中 NODE_VERSION=22，然后："
    error "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE down"
    error "  bash $0"
  fi
  exit 1
fi

# ── 完成 ──

NAS_IP=$(hostname -I | awk '{print $1}')
CHRONO_PORT=$(grep "^CHRONO_PORT=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "3000")
JAEGER_PORT=$(grep "^JAEGER_UI_PORT=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "16686")

echo ""
info "==========================================="
info "  ChronoSynthOS 主人格节点部署成功！"
info "==========================================="
info ""
info "  API:    http://${NAS_IP}:${CHRONO_PORT}"
info "  健康:   http://${NAS_IP}:${CHRONO_PORT}/healthz"
info "  就绪:   http://${NAS_IP}:${CHRONO_PORT}/readyz"
info "  SSE:    http://${NAS_IP}:${CHRONO_PORT}/api/v1/events/stream"
info "  WS:     ws://${NAS_IP}:${CHRONO_PORT}/ws"
info "  Jaeger: http://${NAS_IP}:${JAEGER_PORT}"
info ""
info "管理命令（在项目目录下执行）："
info "  查看日志: docker compose -f deploy/synology/docker-compose.yml logs -f backend"
info "  停止服务: docker compose -f deploy/synology/docker-compose.yml down"
info "  重启后端: docker compose -f deploy/synology/docker-compose.yml restart backend"
info "  查看状态: docker compose -f deploy/synology/docker-compose.yml ps"
info ""
