#!/usr/bin/env bash
#
# setup-nas-beta.sh — Bootstrap chrono-synth v2.0.0-beta.1 on a Synology NAS.
#
# 配套：docs/release/v2.0.0-beta.1-nas-quickstart.md
# 目标：把 quick-start 第 2~5 步的全部命令固化成一个 idempotent 脚本。
#       你审一遍这个文件、bash 执行、贴 log。脚本不上行任何东西，
#       密钥不离开 NAS，所有 sudo 由你显式触发。
#
# 用法：
#   chmod +x setup-nas-beta.sh
#   bash setup-nas-beta.sh /volume2/docker/chrono-beta chrono-beta.example.com
#                          └── 部署目录 ────┘ └── BETA_DOMAIN ─────┘
#
#   如果暂无域名，第二个参数填 NAS 内网 IP（如 192.168.1.10），脚本会自动
#   切到 Caddy tls internal 模式。
#
# 安全约定：
#   - 已有 .env / 已有密钥 / 已有 docker-compose.yml：默认 SKIP 不覆盖。
#   - 强制重新生成：传 --force（注意会清密钥但不动 data/）
#   - 整段执行 tee 到 ./beta-setup.log；密钥内容不进 log
#
# 退出码：
#   0  全部步骤完成（不代表服务起来了；起服务由你 docker compose up）
#   1  前置条件缺失（docker、openssl、awk 等）
#   2  网络问题（GHCR pull 失败）
#   3  用户输入错误（参数格式 / 路径不可写）
#   4  生成或写文件失败
#

set -u  # 未定义变量立刻报错
set -o pipefail

# ──────────────────────────────────────────────────────────────
# 全局变量 + 参数解析
# ──────────────────────────────────────────────────────────────

SCRIPT_VERSION="v2.0.0-beta.1"
OS_IMAGE="ghcr.io/wontlost-ltd/chrono-synth-os:2.0.0-beta.1"
WEB_IMAGE="ghcr.io/wontlost-ltd/chrono-synth-web:2.0.0-beta.1"
GHCR_USER="jet-pang"

DEPLOY_DIR=""
BETA_DOMAIN=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    -*)
      echo "未知选项: $1" >&2
      exit 3
      ;;
    *)
      if [[ -z "$DEPLOY_DIR" ]]; then DEPLOY_DIR="$1"
      elif [[ -z "$BETA_DOMAIN" ]]; then BETA_DOMAIN="$1"
      else
        echo "多余参数: $1" >&2
        exit 3
      fi
      shift
      ;;
  esac
done

if [[ -z "$DEPLOY_DIR" || -z "$BETA_DOMAIN" ]]; then
  echo "用法: bash setup-nas-beta.sh <deploy-dir> <beta-domain>" >&2
  echo "示例: bash setup-nas-beta.sh /volume2/docker/chrono-beta chrono-beta.example.com" >&2
  exit 3
fi

# 探测 BETA_DOMAIN 是 IP 还是域名（决定 Caddy 用 tls internal 还是真证书）
USE_INTERNAL_TLS=0
if [[ "$BETA_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  USE_INTERNAL_TLS=1
fi

LOG_FILE="${DEPLOY_DIR}/beta-setup.log"

# ──────────────────────────────────────────────────────────────
# 工具函数
# ──────────────────────────────────────────────────────────────

log() {
  # 普通信息：进 stdout + log
  local msg="$1"
  echo "[$(date '+%H:%M:%S')] $msg" | tee -a "$LOG_FILE"
}

warn() {
  echo "[$(date '+%H:%M:%S')] ⚠️  $1" | tee -a "$LOG_FILE" >&2
}

die() {
  local code="${2:-4}"
  echo "[$(date '+%H:%M:%S')] ❌ $1" | tee -a "$LOG_FILE" >&2
  echo "中止。详见 $LOG_FILE" >&2
  exit "$code"
}

# 把命令输出 tee 到 log，同时回显
run() {
  log "$ $*"
  "$@" 2>&1 | tee -a "$LOG_FILE"
  return "${PIPESTATUS[0]}"
}

# 检查文件是否存在 + 决定 SKIP / OVERWRITE / FORCE
should_write() {
  local path="$1"
  if [[ -e "$path" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      log "[force] 覆盖 $path"
      return 0
    else
      log "[skip] $path 已存在（用 --force 覆盖）"
      return 1
    fi
  fi
  return 0
}

# ──────────────────────────────────────────────────────────────
# Step 0: 前置环境检查
# ──────────────────────────────────────────────────────────────

step0_preflight() {
  log "========= Step 0: 前置检查 ========="

  for cmd in docker openssl awk sed grep; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      die "缺少命令: $cmd"
    fi
  done
  log "✓ docker / openssl / awk / sed / grep 都在"

  # docker daemon 可访问？
  if ! docker info >/dev/null 2>&1; then
    if sudo -n docker info >/dev/null 2>&1; then
      warn "docker daemon 需要 sudo —— 后续 docker 命令会自动加 sudo"
      DOCKER_CMD="sudo docker"
    else
      die "docker daemon 不可访问。把当前用户加到 docker 组，或确保 sudo 不需要密码"
    fi
  else
    DOCKER_CMD="docker"
  fi
  log "✓ docker daemon 可访问（用 \"$DOCKER_CMD\"）"

  # docker compose v2
  if ! $DOCKER_CMD compose version >/dev/null 2>&1; then
    die "docker compose v2 不可用。Synology Container Manager 通常自带，老版本 docker-compose 不行"
  fi
  log "✓ docker compose v2 可用"

  # GHCR 已登录？
  if ! grep -q '"https://ghcr.io"' "${HOME}/.docker/config.json" 2>/dev/null \
     && ! sudo test -f /root/.docker/config.json; then
    warn "未检测到 ghcr.io 登录态。如果 pull 失败，先跑："
    warn "    echo '<PAT>' | $DOCKER_CMD login ghcr.io -u ${GHCR_USER} --password-stdin"
  else
    log "✓ ghcr.io 登录态已缓存"
  fi

  # 部署目录可写？
  mkdir -p "$DEPLOY_DIR" || die "无法创建 $DEPLOY_DIR（权限不足？）" 3
  if [[ ! -w "$DEPLOY_DIR" ]]; then
    die "$DEPLOY_DIR 不可写" 3
  fi
  cd "$DEPLOY_DIR" || die "无法进入 $DEPLOY_DIR" 3
  log "✓ 部署目录 $DEPLOY_DIR 就绪"
}

# ──────────────────────────────────────────────────────────────
# Step 1: docker pull image（验证 GHCR 访问 + 缓存到本地）
# ──────────────────────────────────────────────────────────────

step1_pull_images() {
  log "========= Step 1: 拉取 image ========="
  log "OS:  $OS_IMAGE"
  log "Web: $WEB_IMAGE"

  if ! $DOCKER_CMD pull "$OS_IMAGE" 2>&1 | tee -a "$LOG_FILE"; then
    die "拉取 $OS_IMAGE 失败。GHCR 没登录？PAT 没 read:packages 权限？" 2
  fi
  if ! $DOCKER_CMD pull "$WEB_IMAGE" 2>&1 | tee -a "$LOG_FILE"; then
    die "拉取 $WEB_IMAGE 失败" 2
  fi
  log "✓ 两个 image 拉取成功"
}

# ──────────────────────────────────────────────────────────────
# Step 2: 生成 JWT 密钥
# ──────────────────────────────────────────────────────────────

step2_jwt_keys() {
  log "========= Step 2: JWT 密钥 ========="
  mkdir -p jwt-keys

  if should_write jwt-keys/kid-1.priv.pem; then
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
      -out jwt-keys/kid-1.priv.pem 2>>"$LOG_FILE" \
      || die "openssl genpkey 失败"
    openssl rsa -in jwt-keys/kid-1.priv.pem -pubout \
      -out jwt-keys/kid-1.pub.pem 2>>"$LOG_FILE" \
      || die "openssl rsa 提取公钥失败"
    chmod 600 jwt-keys/kid-1.priv.pem
    chmod 644 jwt-keys/kid-1.pub.pem
    log "✓ 生成 kid-1 RS256 keypair（priv: 0600, pub: 0644）"
  fi

  # 完整性校验
  if ! openssl rsa -in jwt-keys/kid-1.priv.pem -check -noout >/dev/null 2>&1; then
    die "kid-1.priv.pem 校验失败（文件被改坏了？传 --force 重生）"
  fi
  log "✓ 密钥完整性 OK"
}

# ──────────────────────────────────────────────────────────────
# Step 3: 写 .env
# ──────────────────────────────────────────────────────────────

step3_env_file() {
  log "========= Step 3: 写 .env ========="

  if ! should_write .env; then
    log "保留你现有的 .env（包含先前生成的密码 + 密钥）"
    return 0
  fi

  local pg_pass enc_key priv_inline pub_inline
  pg_pass="$(openssl rand -hex 24)"
  enc_key="$(openssl rand -hex 32)"
  # PEM 多行 -> 单行 \n 字面量
  priv_inline="$(awk '{printf "%s\\n", $0}' jwt-keys/kid-1.priv.pem)"
  pub_inline="$(awk '{printf "%s\\n", $0}' jwt-keys/kid-1.pub.pem)"

  cat > .env <<EOF
# 生成时间: $(date -Iseconds)
# 脚本版本: setup-nas-beta.sh ($SCRIPT_VERSION)
#
# ⚠️  此文件含密钥。永远不要 commit / 不要分享。chmod 600 已锁。

BETA_DOMAIN=${BETA_DOMAIN}
POSTGRES_PASSWORD=${pg_pass}

# SQLCipher / 字段加密的 master key
CHRONO_FIELD_ENC_MASTER_KEY=${enc_key}

# JWT 单 key 模式：legacy CHRONO_JWT_PRIVATE_KEY/PUBLIC_KEY（PEM 字符串）。
# v2.0.0-beta.1 之后 rotate API 不再需要重启即可热换 active key。
CHRONO_JWT_KID=kid-1
CHRONO_JWT_PRIVATE_KEY=${priv_inline}
CHRONO_JWT_PUBLIC_KEY=${pub_inline}
EOF

  chmod 600 .env
  log "✓ 写 .env（chmod 600）"
  log "  POSTGRES_PASSWORD 已生成（24 byte hex，不显示）"
  log "  CHRONO_FIELD_ENC_MASTER_KEY 已生成（32 byte hex，不显示）"
  log "  CHRONO_JWT_PRIVATE_KEY 已嵌入 PEM 字符串"

  # 自检
  grep -q '^BETA_DOMAIN=' .env || die ".env 校验失败：缺 BETA_DOMAIN"
  [[ $(grep -c '^CHRONO_JWT_PRIVATE_KEY=' .env) -eq 1 ]] \
    || die ".env 校验失败：CHRONO_JWT_PRIVATE_KEY 行数不对"
  grep -q 'BEGIN PRIVATE KEY' .env || die ".env 校验失败：私钥字符串没正确嵌入"
  log "✓ .env 自检通过"
}

# ──────────────────────────────────────────────────────────────
# Step 4: 写 docker-compose.yml
# ──────────────────────────────────────────────────────────────

step4_compose() {
  log "========= Step 4: 写 docker-compose.yml ========="

  if ! should_write docker-compose.yml; then
    return 0
  fi

  cat > docker-compose.yml <<'YAML'
# 由 setup-nas-beta.sh 生成。修改前请理解：
# - service name 'backend' 不能改：chrono-synth-web 的 nginx.conf 写死
#   proxy_pass http://backend:3000，改名会导致 /api/* 全部 502
# - 端口 127.0.0.1:3000 / 127.0.0.1:8080 故意只 bind 本地，对外走 caddy
# - data/ 卷不要随便 rm —— 那里有 postgres + sqlite + caddy 证书

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: chrono
      POSTGRES_USER: chrono
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U chrono"]
      interval: 10s
      timeout: 5s
      retries: 5

  backend:
    image: ghcr.io/wontlost-ltd/chrono-synth-os:2.0.0-beta.1
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      CHRONO_DB_DRIVER: postgres
      CHRONO_DB_CONNECTION_STRING: postgres://chrono:${POSTGRES_PASSWORD}@postgres:5432/chrono
      CHRONO_SERVER_HOST: 0.0.0.0
      CHRONO_SERVER_PORT: '3000'
      CHRONO_SERVER_PUBLIC_URL: https://${BETA_DOMAIN}
      CHRONO_LOG_LEVEL: info
      CHRONO_LOG_JSON: 'true'
      CHRONO_JWT_ENABLED: 'true'
      CHRONO_JWT_ALGORITHM: RS256
      CHRONO_JWT_ISSUER: https://${BETA_DOMAIN}
      CHRONO_JWT_ACCESS_TTL_MS: '900000'
      CHRONO_JWT_REFRESH_TTL_MS: '2592000000'
      CHRONO_JWT_KID: ${CHRONO_JWT_KID}
      CHRONO_JWT_PRIVATE_KEY: ${CHRONO_JWT_PRIVATE_KEY}
      CHRONO_JWT_PUBLIC_KEY: ${CHRONO_JWT_PUBLIC_KEY}
      CHRONO_AUTH_ENABLED: 'true'
      CHRONO_CORS_ORIGIN: 'true'
      CHRONO_CORS_CREDENTIALS: 'true'
    volumes:
      - ./data/os:/app/data
    ports:
      - "127.0.0.1:3000:3000"

  web:
    image: ghcr.io/wontlost-ltd/chrono-synth-web:2.0.0-beta.1
    restart: unless-stopped
    depends_on:
      - backend
    environment:
      CHRONO_WEB_API_BASE_URL: https://${BETA_DOMAIN}
      CHRONO_WEB_ENVIRONMENT: beta
    ports:
      - "127.0.0.1:8080:8080"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - backend
      - web
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data/caddy/data:/data
      - ./data/caddy/config:/config
    environment:
      BETA_DOMAIN: ${BETA_DOMAIN}
YAML

  chmod 644 docker-compose.yml
  log "✓ 写 docker-compose.yml"
}

# ──────────────────────────────────────────────────────────────
# Step 5: 写 Caddyfile
# ──────────────────────────────────────────────────────────────

step5_caddyfile() {
  log "========= Step 5: 写 Caddyfile ========="

  if ! should_write Caddyfile; then
    return 0
  fi

  if [[ "$USE_INTERNAL_TLS" -eq 1 ]]; then
    log "BETA_DOMAIN=$BETA_DOMAIN 是 IP，启用 tls internal（自签证书）"
    cat > Caddyfile <<'CADDY'
:443 {
    tls internal
    encode gzip

    handle /api/v1/feature-flags/stream {
        reverse_proxy backend:3000 {
            transport http {
                read_timeout 24h
            }
            flush_interval -1
        }
    }
    handle /.well-known/jwks.json { reverse_proxy backend:3000 }
    handle /api/* { reverse_proxy backend:3000 }
    handle /healthz { reverse_proxy backend:3000 }
    handle /readyz { reverse_proxy backend:3000 }
    handle { reverse_proxy web:8080 }
}

:80 {
    redir https://{host}{uri} permanent
}
CADDY
  else
    log "BETA_DOMAIN=$BETA_DOMAIN 是域名，Caddy 会向 Let's Encrypt 申请真证书"
    cat > Caddyfile <<CADDY
{\$BETA_DOMAIN} {
    encode gzip

    handle /api/v1/feature-flags/stream {
        reverse_proxy backend:3000 {
            transport http {
                read_timeout 24h
            }
            flush_interval -1
        }
    }
    handle /.well-known/jwks.json { reverse_proxy backend:3000 }
    handle /api/* { reverse_proxy backend:3000 }
    handle /healthz { reverse_proxy backend:3000 }
    handle /readyz { reverse_proxy backend:3000 }
    handle { reverse_proxy web:8080 }
}
CADDY
  fi

  chmod 644 Caddyfile
  log "✓ 写 Caddyfile"
}

# ──────────────────────────────────────────────────────────────
# Step 6: docker compose config 静态校验
# ──────────────────────────────────────────────────────────────

step6_validate() {
  log "========= Step 6: 校验 compose 配置 ========="

  # 不连 daemon，纯解析校验
  if ! $DOCKER_CMD compose --env-file .env config -q 2>&1 | tee -a "$LOG_FILE"; then
    die "docker compose config 校验失败 —— .env 或 yaml 有语法错"
  fi
  log "✓ docker-compose.yml + .env 组合语法 OK"
}

# ──────────────────────────────────────────────────────────────
# Step 7: 打印验收命令
# ──────────────────────────────────────────────────────────────

step7_report() {
  log "========= Step 7: 完成。下一步由你执行 ========="
  # shellcheck disable=SC2012  # ls 仅作为 final report 显示固定文件，无注入风险
  cat <<EOF | tee -a "$LOG_FILE"

  目录 ${DEPLOY_DIR} 已就绪。文件清单：
    .env                  $(ls -la .env 2>/dev/null | awk '{print $1, $5}')
    docker-compose.yml    $(ls -la docker-compose.yml 2>/dev/null | awk '{print $1, $5}')
    Caddyfile             $(ls -la Caddyfile 2>/dev/null | awk '{print $1, $5}')
    jwt-keys/kid-1.*      $(ls jwt-keys/ 2>/dev/null | tr '\n' ' ')

  下一步（你手动跑）：

  1) 启动栈：
       $DOCKER_CMD compose up -d

  2) 等所有 service healthy（30-60s）：
       $DOCKER_CMD compose ps

  3) 看 backend 日志确认 schema 迁移成功 + KeyRing 装载：
       $DOCKER_CMD compose logs backend | grep -iE "(migration|KeyRing|listening)"

  4) 跑验收（NAS-01）：
       curl -sk https://${BETA_DOMAIN}/healthz
       curl -sk https://${BETA_DOMAIN}/readyz
       curl -sk https://${BETA_DOMAIN}/.well-known/jwks.json | head -50

  5) JWT 热轮换验证（NAS-03，这是 §8 #1 Critical 修复的实战验证）：
       详 docs/release/v2.0.0-beta.1-nas-quickstart.md 第 5 步

  全程日志: $LOG_FILE

EOF
}

# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

main() {
  # 必须先 mkdir 再 tee log
  mkdir -p "$DEPLOY_DIR" || { echo "无法创建 $DEPLOY_DIR" >&2; exit 3; }
  : > "$LOG_FILE"  # truncate
  log "setup-nas-beta.sh 启动 — DEPLOY_DIR=$DEPLOY_DIR, BETA_DOMAIN=$BETA_DOMAIN, FORCE=$FORCE"

  step0_preflight
  step1_pull_images
  step2_jwt_keys
  step3_env_file
  step4_compose
  step5_caddyfile
  step6_validate
  step7_report

  log "✅ setup-nas-beta.sh 结束（exit 0）"
}

main "$@"
