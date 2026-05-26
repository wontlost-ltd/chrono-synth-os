#!/usr/bin/env bash
#
# setup-nas-beta.sh — Bootstrap chrono-synth v2.0.0-beta on a Synology NAS via Cloudflare Tunnel.
#
# 配套：docs/release/v2.0.0-beta.1-nas-quickstart.md
#       docs/release/cloudflare-tunnel-setup.md（CF dashboard 配置步骤）
#
# 架构（公网域名 + CF Tunnel）：
#   浏览器 → CF edge (TLS) → CF Tunnel → cloudflared (NAS, docker) → web:8080 (nginx)
#                                                                       │
#                                                              proxy_pass /api/* 到 backend:3000
#
#   NAS 上不开 80/443 公网端口；web/backend 仅 bind 127.0.0.1。
#
# 用法：
#   chmod +x setup-nas-beta.sh
#   bash setup-nas-beta.sh /volume2/docker/chrono-beta chrono-synth-beta.wontlost.com <CF_TUNNEL_TOKEN>
#                          └── 部署目录 ────┘ └── 公网域名 ──────────────┘ └── CF Tunnel token ─┘
#
# CF Tunnel token 来源：Cloudflare Zero Trust → Networks → Tunnels → 你建的 tunnel → "Install connector"
#                       页面上有一长串 "eyJhIjoi..." 字符串；复制粘贴整个串作为第三个参数。
#
# 安全约定：
#   - 已有 .env / 已有密钥 / 已有 docker-compose.yml：默认 SKIP 不覆盖。
#   - 强制重新生成：传 --force（会清密钥 + .env 但不动 data/）
#   - 整段执行 tee 到 ./beta-setup.log；密钥 / token 内容不进 log
#
# 退出码：
#   0  全部步骤完成
#   1  前置条件缺失（docker、openssl、awk 等）
#   2  网络问题（GHCR pull 失败）
#   3  用户输入错误（参数格式 / 路径不可写）
#   4  生成或写文件失败
#

set -u
set -o pipefail

# ──────────────────────────────────────────────────────────────
# 全局变量 + 参数解析
# ──────────────────────────────────────────────────────────────

SCRIPT_VERSION="v2.0.0-beta.4"
OS_IMAGE="ghcr.io/wontlost-ltd/chrono-synth-os:2.0.0-beta.4"
WEB_IMAGE="ghcr.io/wontlost-ltd/chrono-synth-web:2.0.0-beta.3"
CLOUDFLARED_IMAGE="cloudflare/cloudflared:latest"
# docker.io/pgvector/pgvector:pg17 = postgres 17 预装 pgvector C extension。
# 显式带 docker.io/ 前缀是给 podman 友好（docker 默认就拉 hub，无副作用）。
# chrono-synth-os 的 DSL 迁移含 CREATE EXTENSION vector（向量召回 ANN 索引），
# 标准 postgres:* 不带 pgvector → backend 启动时迁移失败：
#   Error: extension "vector" is not available
# ⚠️ 升级 pg major 版本（pg16 → pg17）不能复用旧 data 目录，必须清空 data/postgres
# 后重新初始化，否则 pg17 拒绝挂载 pg16 的 catalog。
POSTGRES_IMAGE="docker.io/pgvector/pgvector:pg17"
GHCR_USER="jet-pang"

DEPLOY_DIR=""
BETA_DOMAIN=""
CF_TUNNEL_TOKEN=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --help|-h)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    -*)
      echo "未知选项: $1" >&2
      exit 3
      ;;
    *)
      if [[ -z "$DEPLOY_DIR" ]]; then DEPLOY_DIR="$1"
      elif [[ -z "$BETA_DOMAIN" ]]; then BETA_DOMAIN="$1"
      elif [[ -z "$CF_TUNNEL_TOKEN" ]]; then CF_TUNNEL_TOKEN="$1"
      else
        echo "多余参数: $1" >&2
        exit 3
      fi
      shift
      ;;
  esac
done

if [[ -z "$DEPLOY_DIR" || -z "$BETA_DOMAIN" || -z "$CF_TUNNEL_TOKEN" ]]; then
  cat >&2 <<EOF
用法: bash setup-nas-beta.sh <deploy-dir> <beta-domain> <cf-tunnel-token>

示例:
  bash setup-nas-beta.sh \\
    /volume2/docker/chrono-beta \\
    chrono-synth-beta.wontlost.com \\
    eyJhIjoiYWJjZGVmZ2hpams...（一长串 token）

CF Tunnel token 在 Cloudflare Zero Trust dashboard → Networks → Tunnels
→ 选你建的 tunnel → "Install connector" 页面里复制。

如果还没建 tunnel，先看 docs/release/cloudflare-tunnel-setup.md。
EOF
  exit 3
fi

# 简单校验 token 格式（CF tunnel token 是 base64 编码的 JSON，至少 100 字符）
if [[ ${#CF_TUNNEL_TOKEN} -lt 100 ]]; then
  echo "❌ CF_TUNNEL_TOKEN 看起来太短（${#CF_TUNNEL_TOKEN} 字符）。" >&2
  echo "   正确的 token 应该是一长串 eyJhIjoi... 起头的 base64 字符串，通常 200+ 字符。" >&2
  exit 3
fi

# 简单校验 BETA_DOMAIN 是 FQDN（不能是 IP）
if [[ "$BETA_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ BETA_DOMAIN 不能是 IP 地址。" >&2
  echo "   CF Tunnel 必须配真域名（如 chrono-synth-beta.wontlost.com）。" >&2
  echo "   如果你想用 IP / 内网测试，看旧版 quickstart 的 tls internal fallback。" >&2
  exit 3
fi

LOG_FILE="${DEPLOY_DIR}/beta-setup.log"

# ──────────────────────────────────────────────────────────────
# 工具函数
# ──────────────────────────────────────────────────────────────

log() {
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

DOCKER_CMD="docker"

# ──────────────────────────────────────────────────────────────
# Step 0: 前置环境检查
# ──────────────────────────────────────────────────────────────

step0_preflight() {
  log "========= Step 0: 前置检查 ========="

  for cmd in docker openssl awk sed grep; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      die "缺少命令: $cmd" 1
    fi
  done
  log "✓ docker / openssl / awk / sed / grep 都在"

  if ! docker info >/dev/null 2>&1; then
    if sudo -n docker info >/dev/null 2>&1; then
      warn "docker daemon 需要 sudo —— 后续 docker 命令会自动加 sudo"
      DOCKER_CMD="sudo docker"
    else
      die "docker daemon 不可访问。把当前用户加到 docker 组，或确保 sudo 不需要密码" 1
    fi
  fi
  log "✓ docker daemon 可访问（用 \"$DOCKER_CMD\"）"

  if ! $DOCKER_CMD compose version >/dev/null 2>&1; then
    die "docker compose v2 不可用。Synology Container Manager 通常自带" 1
  fi
  log "✓ docker compose v2 可用"

  if ! grep -q '"https://ghcr.io"' "${HOME}/.docker/config.json" 2>/dev/null \
     && ! sudo test -f /root/.docker/config.json 2>/dev/null; then
    warn "未检测到 ghcr.io 登录态。如果 pull 失败，先跑："
    warn "    echo '<PAT>' | $DOCKER_CMD login ghcr.io -u ${GHCR_USER} --password-stdin"
  else
    log "✓ ghcr.io 登录态已缓存"
  fi

  mkdir -p "$DEPLOY_DIR" || die "无法创建 $DEPLOY_DIR" 3
  if [[ ! -w "$DEPLOY_DIR" ]]; then
    die "$DEPLOY_DIR 不可写" 3
  fi
  cd "$DEPLOY_DIR" || die "无法进入 $DEPLOY_DIR" 3
  log "✓ 部署目录 $DEPLOY_DIR 就绪"
}

# ──────────────────────────────────────────────────────────────
# Step 1: docker pull 所有 image
# ──────────────────────────────────────────────────────────────

step1_pull_images() {
  log "========= Step 1: 拉取 image ========="
  log "OS:          $OS_IMAGE"
  log "Web:         $WEB_IMAGE"
  log "cloudflared: $CLOUDFLARED_IMAGE"
  log "postgres:    $POSTGRES_IMAGE"

  for img in "$OS_IMAGE" "$WEB_IMAGE" "$CLOUDFLARED_IMAGE" "$POSTGRES_IMAGE"; do
    if ! $DOCKER_CMD pull "$img" 2>&1 | tee -a "$LOG_FILE"; then
      die "拉取 $img 失败。GHCR 没登录？PAT 没 read:packages 权限？" 2
    fi
  done
  log "✓ 全部 image 拉取成功"
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
    # 私钥严格 0600 留在主机 + chown 给 OS image 内置的 chrono uid (1001)。
    # OS Dockerfile 把 chrono uid 固定为 1001 让 bind-mount 在 host 端
    # 用同样 uid 时容器进程能直接读，不需要 user: "0" 也不需要 entrypoint
    # cat wrapper。GA 安全要求（backend 不以 root 跑）的根因修复。
    chmod 700 jwt-keys
    chmod 600 jwt-keys/kid-1.priv.pem
    chmod 644 jwt-keys/kid-1.pub.pem
    if command -v chown >/dev/null 2>&1; then
      # 用 sudo 是因为 host 上的 chrono 用户大概率没有 uid 1001；
      # bind mount 用 docker 自己的 uid namespace，宿主用 sudo chown 即可。
      sudo chown -R 1001:1001 jwt-keys 2>/dev/null \
        || warn "chown 1001:1001 失败 — 检查 sudo 权限；如果 backend 报 EACCES 读 PEM，手动 sudo chown -R 1001:1001 jwt-keys"
    fi
    log "✓ 生成 kid-1 RS256 keypair（dir 0700, priv 0600, pub 0644, owner uid=1001）"
  fi

  if ! openssl rsa -in jwt-keys/kid-1.priv.pem -check -noout >/dev/null 2>&1; then
    die "kid-1.priv.pem 校验失败（用 --force 重生）"
  fi
  log "✓ 密钥完整性 OK"
}

# ──────────────────────────────────────────────────────────────
# Step 3: 写 .env
# ──────────────────────────────────────────────────────────────

step3_env_file() {
  log "========= Step 3: 写 .env ========="

  if ! should_write .env; then
    log "保留你现有的 .env"
    return 0
  fi

  # postgres 只在首次启动（data 卷为空）才用 .env 的 POSTGRES_PASSWORD
  # 初始化 user。如果 data/postgres 不空 + .env 是新生成的，旧用户密码
  # 和 .env 新密码不匹配，backend 启动会撞 "password authentication failed
  # for user chrono"。检测到 data/postgres 非空就 abort，让用户显式决定
  # 是清数据还是手动同步密码。
  if [[ -d data/postgres ]] && [[ -n "$(ls -A data/postgres 2>/dev/null || true)" ]]; then
    die "data/postgres/ 已有 postgres 数据，但 .env 即将生成新 POSTGRES_PASSWORD。
新密码与旧数据里 chrono user 不匹配，backend 会启动失败。

选项：
  (a) 清空 postgres data 重新初始化（beta 内测推荐 — 零业务数据损失）：
        sudo docker compose down
        sudo rm -rf data/postgres && sudo mkdir -p data/postgres
        bash ${0##*/} --force . ${BETA_DOMAIN} '<CF_TUNNEL_TOKEN>'

  (b) 手动同步：先在 postgres 容器里 ALTER USER chrono PASSWORD '...'，
      然后用旧密码值手写 .env，跑本脚本不带 --force。"
  fi

  local pg_pass enc_key
  pg_pass="$(openssl rand -hex 24)"
  enc_key="$(openssl rand -hex 32)"

  # ⚠️ JWT PEM 不再嵌入 .env，理由：
  # docker compose 把 .env 当字面字符串注入容器 env。多行 PEM 在 .env 里
  # 只能用 \n 字面量（不能内嵌真换行），但 docker compose 不会还原 \n —
  # 容器收到的就是字面 "\n"，fast-jwt 报 "PEM section not found"。
  # 改用 volume 挂载 jwt-keys/ 到容器，backend 的 command shell wrapper
  # 用 cat 读文件（保留真换行）后 export 成 env。

  cat > .env <<EOF
# 生成时间: $(date -Iseconds)
# 脚本版本: setup-nas-beta.sh ($SCRIPT_VERSION)
#
# ⚠️  此文件含密码 + tunnel token。永远不要 commit / 不要分享。chmod 600 已锁。
#     JWT PEM 文件单独放在 jwt-keys/ 目录，通过 docker volume 挂载，
#     不在本 .env 里。

BETA_DOMAIN=${BETA_DOMAIN}
POSTGRES_PASSWORD=${pg_pass}
CHRONO_FIELD_ENC_MASTER_KEY=${enc_key}

CHRONO_JWT_KID=kid-1

# Cloudflare Tunnel
# 这是 cloudflared 连 CF 边缘需要的凭据；token 失效就重新生成
CF_TUNNEL_TOKEN=${CF_TUNNEL_TOKEN}
EOF

  chmod 600 .env
  log "✓ 写 .env（chmod 600）"
  log "  POSTGRES_PASSWORD 已生成（24 byte hex）"
  log "  CHRONO_FIELD_ENC_MASTER_KEY 已生成（32 byte hex）"
  log "  CHRONO_JWT_KID=kid-1（PEM 走 volume 挂载，不嵌入 .env）"
  log "  CF_TUNNEL_TOKEN 已嵌入（长度 ${#CF_TUNNEL_TOKEN}）"

  grep -q '^BETA_DOMAIN=' .env || die ".env 自检失败：缺 BETA_DOMAIN"
  grep -q '^CF_TUNNEL_TOKEN=' .env || die ".env 自检失败：缺 CF_TUNNEL_TOKEN"
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
# 由 setup-nas-beta.sh 生成。
#
# 架构：CF Tunnel 模式，NAS 不开 80/443 公网端口。
#
# 关键约束：
# - service name 'backend' 不能改：chrono-synth-web 的 nginx.conf 写死
#   proxy_pass http://backend:3000，改名 → /api/* 全部 502。
# - 'web' 是 cloudflared 的 upstream，service name 必须叫 web（或同步改
#   CF Tunnel 配置里的 service URL）。
# - backend/web 仅 bind 127.0.0.1（如果要本地直接调用 backend 调试用），
#   CF Tunnel 走 docker 内部网络到 web:8080，不需要公网端口。
# - postgres 不暴露任何端口，只在 docker network 内被 backend 访问。
# - data/ 卷不要随便 rm —— 那里有 postgres + sqlite。

services:
  postgres:
    image: docker.io/pgvector/pgvector:pg17
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
    image: ghcr.io/wontlost-ltd/chrono-synth-os:2.0.0-beta.4
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    # 用 image 内置的非 root user (chrono uid=100+)，不再 user: "0"。
    # PEM 通过 _FILE env 读，OS image v2.0.0-beta.4+ 在 config loader
    # 里 readFileSync 同步加载，不需要 entrypoint wrapper / 不需要 root。
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
      # PEM 走文件挂载 + _FILE env，避免 docker compose .env 多行
      # 转义陷阱（\n 字面量），同时让容器非 root 跑（GA 安全要求）。
      CHRONO_JWT_PRIVATE_KEY_FILE: /run/secrets/jwt-keys/kid-1.priv.pem
      CHRONO_JWT_PUBLIC_KEY_FILE: /run/secrets/jwt-keys/kid-1.pub.pem
      CHRONO_AUTH_ENABLED: 'true'
      # CORS：浏览器禁止 wildcard "*" + credentials=true 同时存在（CORS spec），
      # 后端代码主动拒绝这种配置。CF Tunnel 模式下 web 和 backend 同源
      # (https://${BETA_DOMAIN})，前端默认相对路径访问 /api/*，CORS 实际
      # 不会触发。这里仍显式 allow 自家域名 + credentials 作为安全默认。
      CHRONO_CORS_ORIGIN: https://${BETA_DOMAIN}
      CHRONO_CORS_CREDENTIALS: 'true'
      # NODE_ENV=production 时 life-simulation 路由要求 queue.enabled=true，
      # 否则注册路由直接抛错。beta 单 NAS 跑 in-process queue 即可。
      CHRONO_QUEUE_ENABLED: 'true'
    volumes:
      - ./data/os:/app/data
      - ./jwt-keys:/run/secrets/jwt-keys:ro
    ports:
      - "127.0.0.1:3000:3000"   # 仅本地调试

  web:
    image: ghcr.io/wontlost-ltd/chrono-synth-web:2.0.0-beta.3
    restart: unless-stopped
    depends_on:
      - backend
    environment:
      # web 端 runtime config：API base URL 走同源（CF Tunnel 后浏览器看到
      # 的就是 https://${BETA_DOMAIN}，浏览器对 /api/* 走相对路径即可）。
      CHRONO_WEB_API_BASE_URL: https://${BETA_DOMAIN}
      CHRONO_WEB_ENVIRONMENT: beta
    # web image 的 nginx.conf 引用了 enterprise 全栈才有的 upstream
    # (observability-worker / prometheus / grafana)。Beta 单 NAS 部署不
    # 跑这些 service，但 nginx startup 阶段对所有 upstream 做 DNS 解析，
    # 找不到就 emerg crash。把这些名字都指向 backend（不会被实际访问，
    # location 路径只在前端用户访问 /worker /prometheus /grafana 时才命中），
    # 让 nginx 启动通过。
    extra_hosts:
      - "observability-worker:127.0.0.1"
      - "prometheus:127.0.0.1"
      - "grafana:127.0.0.1"
    ports:
      - "127.0.0.1:8080:8080"   # 仅本地调试

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    depends_on:
      - web
    # CF Tunnel 用 token 模式启动：
    # - 配置（routing rules、public hostname、service URL）从 CF dashboard 拉取
    # - 本地不需要 config.yml
    # - 多个实例可以用同一 token 做 HA（CF 自动 round-robin）
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CF_TUNNEL_TOKEN}
      # 让 cloudflared 启动时打印 service URL 检查，方便排错
      TUNNEL_METRICS: 0.0.0.0:60123
YAML

  chmod 644 docker-compose.yml
  log "✓ 写 docker-compose.yml"

  # docker bind-mount 要求源路径在 up 之前已存在，否则 postgres / backend
  # 容器一启动就 "Bind mount failed" 拒启。提前 mkdir，避免用户在 step 6
  # 之后撞坑。
  mkdir -p data/postgres data/os
  log "✓ 预创建 data/postgres + data/os（docker bind mount 必需）"
}

# ──────────────────────────────────────────────────────────────
# Step 5: docker compose config 静态校验
# ──────────────────────────────────────────────────────────────

step5_validate() {
  log "========= Step 5: 校验 compose 配置 ========="

  if ! $DOCKER_CMD compose --env-file .env config -q 2>&1 | tee -a "$LOG_FILE"; then
    die "docker compose config 校验失败 —— .env 或 yaml 有语法错"
  fi
  log "✓ docker-compose.yml + .env 组合语法 OK"
}

# ──────────────────────────────────────────────────────────────
# Step 6: 打印验收命令
# ──────────────────────────────────────────────────────────────

step6_report() {
  log "========= Step 6: 完成。下一步由你执行 ========="
  # shellcheck disable=SC2012
  cat <<EOF | tee -a "$LOG_FILE"

  目录 ${DEPLOY_DIR} 已就绪。文件清单：
    .env                  $(ls -la .env 2>/dev/null | awk '{print $1, $5}')
    docker-compose.yml    $(ls -la docker-compose.yml 2>/dev/null | awk '{print $1, $5}')
    jwt-keys/kid-1.*      $(ls jwt-keys/ 2>/dev/null | tr '\n' ' ')

  下一步（你手动跑）：

  1) 启动栈：
       $DOCKER_CMD compose up -d

  2) 看 4 个 service 启动（postgres + backend + web + cloudflared）：
       $DOCKER_CMD compose ps
       期望 4 行都是 healthy / running。

  3) 看 cloudflared 日志确认 tunnel 已连上 CF edge：
       $DOCKER_CMD compose logs cloudflared | grep -iE "(connection|registered|ready)"
       期望看到 "Registered tunnel connection" × 4（CF 通常开 4 条 HA 连接）。

  4) 看 backend 日志确认 schema 迁移 + JWT KeyRing 装载：
       $DOCKER_CMD compose logs backend | grep -iE "(migration|KeyRing|listening|active kid)"

  5) 跑公网验收（从你 Mac / 手机，不是 NAS）：
       curl -s https://${BETA_DOMAIN}/healthz
       curl -s https://${BETA_DOMAIN}/readyz
       curl -s https://${BETA_DOMAIN}/.well-known/jwks.json | head -50
       浏览器打开 https://${BETA_DOMAIN}/login

  6) JWT 热轮换验证（§8 #1 Critical 修复实战 — NAS-03 用例）：
       详 docs/release/v2.0.0-beta.1-nas-quickstart.md 第 5 步

  全程日志: $LOG_FILE

  ⚠️  如果 cloudflared 日志报 "Authorization failed"，说明 CF_TUNNEL_TOKEN
      错了。回 CF dashboard 重新复制 token，重跑：
        bash setup-nas-beta.sh --force $DEPLOY_DIR $BETA_DOMAIN <new-token>

EOF
}

# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

main() {
  mkdir -p "$DEPLOY_DIR" || { echo "无法创建 $DEPLOY_DIR" >&2; exit 3; }
  : > "$LOG_FILE"
  log "setup-nas-beta.sh 启动 — DEPLOY_DIR=$DEPLOY_DIR, BETA_DOMAIN=$BETA_DOMAIN, FORCE=$FORCE, CF_TUNNEL_TOKEN=<隐藏 ${#CF_TUNNEL_TOKEN} 字符>"

  step0_preflight
  step1_pull_images
  step2_jwt_keys
  step3_env_file
  step4_compose
  step5_validate
  step6_report

  log "✅ setup-nas-beta.sh 结束（exit 0）"
}

main "$@"
