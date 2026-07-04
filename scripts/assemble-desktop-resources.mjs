#!/usr/bin/env node
/**
 * 组装桌面安装包的 sidecar 资源（ADR-0061 S4）。
 *
 * 把 build-sidecar.mjs 产出的便携 dist-sidecar/ + **精确锁版本、按目标平台/架构** 的 Node runtime 放进
 * apps/desktop/src-tauri/resources/，供 tauri build 经 bundle.resources 打进安装包。Rust sidecar.rs 从
 * resource_dir 解析：
 *   resource_dir/sidecar/dist/main-desktop.js   ← 便携服务器
 *   resource_dir/node (node.exe on Windows)     ← Node runtime（spawn sidecar 用）
 *
 * Node runtime（红线 6/7：可复现 + 架构匹配，Codex S4 复审补）：**下载脚本内完整 pin 的 NODE_VERSION**
 * 官方 Node 二进制（独立于 .nvmrc 的 major，桌面安装包须完整版本可复现），按 `--target`（Rust target triple）
 * 映射平台/架构——绝不拷 host `process.execPath`（否则 mac arm64/x64 双架构会内嵌错误架构 Node）。校验
 * SHASUMS256 完整性（供应链）。
 *
 * 用法（CI 在 tauri build 之前，target 对应 matrix rust-target）：
 *   node scripts/assemble-desktop-resources.mjs --target aarch64-apple-darwin
 * 缺省 --target=当前 host（本机开发验证用）。
 */

import { cpSync, rmSync, mkdirSync, existsSync, chmodSync, writeFileSync, createReadStream } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_BUNDLE = resolve(ROOT, 'dist-sidecar');
const RES = resolve(ROOT, 'apps/desktop/src-tauri/resources');

function log(m) { process.stdout.write(`[assemble-desktop-resources] ${m}\n`); }

/* Rust target triple → Node dist（platform, arch, ext, node 子路径）。 */
const TARGET_MAP = {
  'aarch64-apple-darwin': { os: 'darwin', arch: 'arm64', ext: 'tar.gz', bin: 'bin/node', win: false },
  'x86_64-apple-darwin': { os: 'darwin', arch: 'x64', ext: 'tar.gz', bin: 'bin/node', win: false },
  'x86_64-unknown-linux-gnu': { os: 'linux', arch: 'x64', ext: 'tar.gz', bin: 'bin/node', win: false },
  'aarch64-unknown-linux-gnu': { os: 'linux', arch: 'arm64', ext: 'tar.gz', bin: 'bin/node', win: false },
  'x86_64-pc-windows-msvc': { os: 'win', arch: 'x64', ext: 'zip', bin: 'node.exe', win: true },
  'aarch64-pc-windows-msvc': { os: 'win', arch: 'arm64', ext: 'zip', bin: 'node.exe', win: true },
};

function hostTarget() {
  const a = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  if (process.platform === 'darwin') return `${a}-apple-darwin`;
  if (process.platform === 'linux') return `${a === 'aarch64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`;
  if (process.platform === 'win32') return `${a}-pc-windows-msvc`;
  throw new Error(`不支持的 host 平台: ${process.platform}`);
}

const targetArg = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : hostTarget();
})();
const spec = TARGET_MAP[targetArg];
if (!spec) throw new Error(`未知 --target ${targetArg}（支持：${Object.keys(TARGET_MAP).join(', ')}）`);

/* 桌面 sidecar 随附的 Node runtime **完整锁定版本**（红线 7 可复现——同 commit 必打同一 Node）。
 * **刻意独立于 .nvmrc**：.nvmrc 是 repo 全局 CI major 锁（"24"，随 setup-node 取最新），会时间漂移；桌面安装包
 * 须完整版本可复现，故单独在此显式 pin。升级须**显式改此常量**（非自动跟随 .nvmrc）。须 >= .nvmrc major。 */
const NODE_VERSION = 'v24.18.0';

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf;
}

async function main() {
  if (!/^v\d+\.\d+\.\d+$/.test(NODE_VERSION)) {
    throw new Error(`NODE_VERSION 必须是完整版本（如 v24.18.0），得到 ${NODE_VERSION}`);
  }
  if (!existsSync(join(SIDECAR_BUNDLE, 'dist', 'main-desktop.js'))) {
    throw new Error('dist-sidecar/dist/main-desktop.js 不存在——请先 `node scripts/build-sidecar.mjs`');
  }

  /* 清理旧资源（保留 README；重建 sidecar/ + node）。 */
  log('清理旧 sidecar 资源…');
  rmSync(join(RES, 'sidecar'), { recursive: true, force: true });
  rmSync(join(RES, 'node'), { force: true });
  rmSync(join(RES, 'node.exe'), { force: true });
  mkdirSync(RES, { recursive: true });

  /* 1. 便携 sidecar bundle → resources/sidecar/ 。 */
  log('拷 sidecar bundle → resources/sidecar/…');
  cpSync(SIDECAR_BUNDLE, join(RES, 'sidecar'), { recursive: true });

  /* 2. 下载**目标平台/架构 + 完整锁版本**官方 Node（红线 6/7）。 */
  const dirName = `node-${NODE_VERSION}-${spec.os}-${spec.arch}`;
  const file = `${dirName}.${spec.ext}`;
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  log(`下载官方 Node ${NODE_VERSION} (${spec.os}/${spec.arch})…`);
  const tmp = join(tmpdir(), `chrono-node-${NODE_VERSION}-${spec.os}-${spec.arch}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, file);
  await download(`${base}/${file}`, archive);

  /* 校验 SHASUMS256（供应链完整性）。 */
  log('校验 SHASUMS256…');
  const sha = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sha.split('\n').find((l) => l.trim().endsWith(`  ${file}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`SHASUMS256 无 ${file} 条目`);
  const actual = await new Promise((res, rej) => {
    const h = createHash('sha256'); const s = createReadStream(archive);
    s.on('data', (d) => h.update(d)); s.on('end', () => res(h.digest('hex'))); s.on('error', rej);
  });
  if (actual !== expected) throw new Error(`Node 归档 SHA256 不符：期望 ${expected} 得 ${actual}`);

  /* 解压 + 取 node 二进制 → resources/。用 `tar -xf`（bsdtar）——现代 Windows Server runner 自带 bsdtar
   * 且能解 zip，跨平台统一（避免 Windows runner 无 `unzip` 的契约风险，Codex S4 复审补）。 */
  log('解压取 node 二进制…');
  execFileSync('tar', ['-xf', archive, '-C', tmp], { stdio: 'inherit' });
  const nodeSrc = join(tmp, dirName, spec.bin);
  const nodeDest = join(RES, spec.win ? 'node.exe' : 'node');
  cpSync(nodeSrc, nodeDest);
  if (!spec.win) chmodSync(nodeDest, 0o755);
  rmSync(tmp, { recursive: true, force: true });

  log(`完成。resources/ 布局：sidecar/dist/main-desktop.js + node(${spec.os}/${spec.arch} ${NODE_VERSION})。tauri build 会打进安装包。`);
}

main().catch((e) => { process.stderr.write(`[assemble-desktop-resources] ❌ ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
