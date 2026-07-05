#!/usr/bin/env bash
# 一键本机打桌面本地安装包（ADR-0061）。
#
# 把完整 Node OS server 内嵌为 Tauri sidecar，打成**本机架构**的双击安装包（未签名，供本地自测）。
# 一条命令跑完 CI「Assemble sidecar resources → Build desktop app」的等价链：
#   1. npm run build            —— 构建全部 workspace 包（build.rs 生成迁移代码要用 schema-dsl 的 dist）
#   2. build-sidecar.mjs --verify —— 生产裁剪便携 sidecar bundle + 便携启动 smoke（拷临时目录起 /readyz）
#   3. assemble-desktop-resources.mjs —— sidecar bundle + 本机架构锁版本 Node 装进 tauri resources
#   4. (apps/desktop) 装应用依赖（含 @tauri-apps/cli）
#   5. tauri build —— 出 .dmg/.app（mac）/ .deb/.rpm/.AppImage（linux）/ .msi/.exe（win）
#
# 未配签名凭据时**必须**关掉 updater 产物（`-c bundle.createUpdaterArtifacts=false`），否则 tauri 报
# 「Missing comment in secret key」失败——与 desktop-release.yml 的「未签名内测」模式一致。
#
# 用法：
#   bash scripts/build-desktop-local.sh            # 打本机架构未签名包
#   SKIP_ASSEMBLE=1 bash scripts/build-desktop-local.sh   # 复用已装好的 resources（跳过 1-3，只重打）
#   TAURI_TARGET=x86_64-apple-darwin bash scripts/build-desktop-local.sh  # 交叉架构（须先装对应 rust target）
#
# 前置：Node 20+/npm、Rust 工具链（rustc/cargo）、对应 rust target（mac arm 机默认已有 aarch64-apple-darwin）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── 探测本机 Rust target triple（与 assemble-desktop-resources.mjs hostTarget 同口径）──────────
detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) arch="aarch64" ;;
    x86_64|amd64)  arch="x86_64" ;;
    *) echo "不支持的架构: $arch" >&2; exit 1 ;;
  esac
  case "$os" in
    Darwin) echo "${arch}-apple-darwin" ;;
    Linux)  echo "${arch}-unknown-linux-gnu" ;;
    *) echo "不支持的平台: $os（Windows 请用 desktop-release.yml 或手动 tauri build）" >&2; exit 1 ;;
  esac
}

TARGET="${TAURI_TARGET:-$(detect_target)}"

log() { printf '\n\033[1;36m[build-desktop-local]\033[0m %s\n' "$1"; }
fail() { printf '\n\033[1;31m[build-desktop-local] ✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 前置检查 ─────────────────────────────────────────────────────────────────────
command -v node >/dev/null || fail "未找到 node（须 Node 20+）"
command -v cargo >/dev/null || fail "未找到 cargo（须安装 Rust 工具链：https://rustup.rs）"
if command -v rustup >/dev/null; then
  if ! rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
    fail "缺 rust target $TARGET —— 先跑：rustup target add $TARGET"
  fi
fi

log "目标架构: $TARGET"

if [ "${SKIP_ASSEMBLE:-0}" != "1" ]; then
  # 0) 先 `npm ci` 恢复 workspace `@chrono/*` 符号链接。TS 靠 node_modules/@chrono/<pkg> 符号链接
  #    解析这些包；链接不全（build-sidecar 的 --install-links staging、误删、部分安装等都可能导致）
  #    会让 tsc 报 `Cannot find module '@chrono/kernel'`。CI 每次 `npm ci` 天然有全套链接；本地脚本
  #    必须同样保证。设 SKIP_NPM_CI=1 可跳过（确定链接已齐时省时间）。
  if [ "${SKIP_NPM_CI:-0}" != "1" ]; then
    log "0/5 npm ci（恢复 workspace 符号链接，保证 @chrono/* 可解析）…"
    npm ci
  fi

  # 1) 干净 checkout 上 workspace 包**无 dist**——根 tsconfig.json 的 project references 在有增量 dist
  #    时能解析，干净树首次构建会报 `Cannot find module '@chrono/kernel'`。故必须像
  #    .github/workflows/ci.yml「Build core packages」一样先按依赖序显式建核心包 dist，再建主源与
  #    npm run build。（与 ci.yml / desktop-release.yml 保持一致，避免漂移。）
  log "1/5 构建 workspace 包（先核心包 dist，再主源 + npm run build）…"
  npx tsc -b \
    packages/contracts/tsconfig.json \
    packages/kernel/tsconfig.json \
    packages/data-plane/tsconfig.json \
    packages/sync-engine/tsconfig.json \
    packages/design-tokens/tsconfig.json \
    packages/schema-dsl/tsconfig.json \
    packages/adapter-web/tsconfig.json \
    packages/adapter-tauri/tsconfig.json \
    packages/adapter-react-native/tsconfig.json
  npx tsc -b tsconfig.src.json
  npm run build

  log "2/5 构建便携 sidecar bundle + 便携启动 smoke（build-sidecar.mjs --verify）…"
  node scripts/build-sidecar.mjs --verify

  log "3/5 组装 tauri resources（sidecar + 本机架构锁版本 Node）…"
  node scripts/assemble-desktop-resources.mjs --target "$TARGET"

  log "4/5 安装 desktop 应用依赖（apps/desktop npm ci）…"
  ( cd apps/desktop && npm ci )
else
  log "SKIP_ASSEMBLE=1 —— 跳过 1-4，复用已有 resources/ 与依赖，仅重打包。"
fi

# ── 打包（未签名内测模式：关 updater 产物；配了 TAURI_SIGNING_PRIVATE_KEY 则去掉 -c 自行签名）──────
log "5/5 tauri build（未签名内测；关 updater 产物）…"
UPDATER_OFF='{"bundle":{"createUpdaterArtifacts":false}}'
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  log "检测到 TAURI_SIGNING_PRIVATE_KEY —— 走签名模式（保留 updater 产物）。"
  ( cd apps/desktop && npx tauri build --target "$TARGET" )
else
  ( cd apps/desktop && npx tauri build --target "$TARGET" -c "$UPDATER_OFF" )
fi

# ── 汇报产物 ─────────────────────────────────────────────────────────────────────
BUNDLE_DIR="apps/desktop/src-tauri/target/${TARGET}/release/bundle"
log "✓ 打包完成。产物目录：$BUNDLE_DIR"
if [ -d "$BUNDLE_DIR" ]; then
  # 列最终产物；跳过 bundle_dmg.sh 的临时 scratch 盘（rw.*.dmg，几百 MB，非交付物）。
  find "$BUNDLE_DIR" -maxdepth 2 -type f \
    \( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.msi' -o -name '*.exe' \) \
    ! -name 'rw.*.dmg' \
    -exec sh -c 'printf "  - %s (%s)\n" "$1" "$(du -h "$1" | cut -f1)"' _ {} \; 2>/dev/null || true
  APP_PATH="$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' 2>/dev/null | head -1 || true)"
  if [ -n "$APP_PATH" ]; then
    printf '\n\033[1;32m自测：\033[0m open %s\n' "$APP_PATH"
    printf '   （若 Gatekeeper 拦未签名包：xattr -dr com.apple.quarantine %s）\n' "$APP_PATH"
    printf '   （看 sidecar 日志：直接跑 %s/Contents/MacOS/* ）\n' "$APP_PATH"
  fi
fi
