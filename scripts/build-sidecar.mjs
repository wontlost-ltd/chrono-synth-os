#!/usr/bin/env node
/**
 * 构建桌面 sidecar 分发产物（ADR-0061 S1）。
 *
 * 产出 dist-sidecar/：一个**自包含、可随附进 Tauri externalBin** 的 Node 服务器副本——
 *   - dist/            ← 已编译服务器 JS（含 main-desktop.js 入口）
 *   - node_modules/    ← **生产裁剪**依赖（npm ci --omit=dev），workspace @chrono/* 经 --install-links **实体化**
 *                        （非符号链接，拷贝到别处仍可 resolve），含 @node-rs/argon2 平台 .node（红线 6）
 *   - package.json     ← 最小运行时清单（type:module + 依赖，供 node 解析）
 *
 * 用法：npm run build（先编译） && node scripts/build-sidecar.mjs
 * 校验：node dist-sidecar/dist/main-desktop.js 应打出 CHRONO_SIDECAR_READY {…} 并可 /readyz。
 *
 * ⚠️ workspace @chrono/* 在 dev 是符号链接（node_modules/@chrono/kernel → ../../packages/kernel），拷贝到
 * Tauri 资源目录会断链。故用 `npm install --omit=dev --install-links`（npm 9+）把 workspace 依赖**实体拷贝**进
 * staging node_modules；这是 npm 官方支持的「把 workspace 当普通文件依赖装」路径。
 *
 * ⚠️ 只装生产依赖（--omit=dev）：剔除 dev/test/build 的原生 .node（rolldown/lightningcss/better-sqlite3 等），
 * 只留运行时（@node-rs/argon2 是唯一运行时原生依赖）。
 */

import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'dist-sidecar');
const STAGING = resolve(ROOT, '.sidecar-staging');

function run(cmd, args, cwd = ROOT) {
  /* Windows 上 `npm` 是 `npm.cmd`——execFileSync 不经 shell 解析不了 `.cmd`（`spawnSync npm ENOENT`）。
   * 显式补后缀（比 shell:true 更安全，避免参数被 shell 二次解析）。其它命令名保持原样。 */
  const resolved = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
  execFileSync(resolved, args, { cwd, stdio: 'inherit' });
}

function log(msg) { process.stdout.write(`[build-sidecar] ${msg}\n`); }

/* 0. 前置校验：必须已 build（dist/main-desktop.js 存在）。 */
if (!existsSync(resolve(ROOT, 'dist/main-desktop.js'))) {
  throw new Error('dist/main-desktop.js 不存在——请先 `npm run build`');
}

/* 0b. 自动推导**运行时**用到的 workspace 包（扫 dist/ 非 test 的 @scope import；避免手维护漏/多）。
 *     只扫运行时代码（排除 dist/test/**），因 test 里会 import 前端 adapter/snapshot 等非服务器运行时包。 */
function scanRuntimeWorkspaceImports() {
  const found = new Set();
  const re = /@(?:chrono|wontlost-ltd)\/[a-z0-9-]+/g;
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (e === 'test') continue;            /* 排除 dist/test/**（test-only 依赖不进 sidecar） */
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e.endsWith('.js')) {
        for (const m of readFileSync(p, 'utf8').matchAll(re)) found.add(m[0]);
      }
    }
  };
  walk(resolve(ROOT, 'dist'));
  return found;
}
/* name → 源码目录（扫 packages/* 的 package.json name）。 */
function workspacePackageDirs() {
  const map = new Map();
  for (const e of readdirSync(resolve(ROOT, 'packages'))) {
    const pj = resolve(ROOT, 'packages', e, 'package.json');
    if (existsSync(pj)) {
      try { map.set(JSON.parse(readFileSync(pj, 'utf8')).name, resolve(ROOT, 'packages', e)); } catch { /* skip */ }
    }
  }
  return map;
}
const runtimeWsImports = scanRuntimeWorkspaceImports();
const wsDirs = workspacePackageDirs();
const wsDeps = {};
for (const name of runtimeWsImports) {
  const dir = wsDirs.get(name);
  if (!dir) throw new Error(`运行时 import 了 workspace 包 ${name} 但 packages/ 下找不到——请核对`);
  wsDeps[name] = `file:${dir}`;
}
log(`运行时 workspace 依赖：${Object.keys(wsDeps).join(', ') || '(none)'}`);

/* 1. 清理旧产物。 */
log('清理旧产物…');
rmSync(OUT, { recursive: true, force: true });
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

/* 2. 组一份最小 package.json（只含运行时 dependencies）——放 staging，供 npm install 装生产依赖。
 *    workspace @chrono/* 用 file: 指向源码目录，--install-links 会实体拷贝其编译产物依赖树。 */
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const stagingPkg = {
  name: 'chrono-synth-sidecar',
  version: rootPkg.version,
  private: true,
  type: 'module',
  dependencies: {
    ...rootPkg.dependencies,
    /* server 运行时用到的 workspace 包（自动推导，file: + --install-links 实体化，非符号链接）。 */
    ...wsDeps,
  },
};
writeFileSync(resolve(STAGING, 'package.json'), JSON.stringify(stagingPkg, null, 2));

/* 3. 生产裁剪安装（--omit=dev 剔 dev/test/build 原生依赖；--install-links 实体化 workspace 包）。 */
log('安装生产依赖（--omit=dev --install-links，剔 dev 原生）…');
run('npm', ['install', '--omit=dev', '--install-links', '--no-audit', '--no-fund'], STAGING);

/* 4. 组装 dist-sidecar/。 */
log('组装 dist-sidecar/…');
mkdirSync(OUT, { recursive: true });
/* 拷 dist/ 但**排除 dist/test/**（test 代码 + test-only 依赖不进 sidecar，减体积 + 不拉前端 adapter）。 */
cpSync(resolve(ROOT, 'dist'), resolve(OUT, 'dist'), {
  recursive: true,
  filter: (src) => !src.includes(`${join('dist', 'test')}`) && !src.endsWith(join('dist', 'test')),
});
/* 拷 node_modules 但**排除 .bin/**（CLI 可执行符号链接——运行时 import 模块不需，且 Tauri bundle 枚举资源时
 * 会因这些符号链接指向的 bin 相对路径而报 resource-not-exist 打包失败，S4 tauri build 实测）。 */
cpSync(resolve(STAGING, 'node_modules'), resolve(OUT, 'node_modules'), {
  recursive: true,
  filter: (src) => !src.split(/[\\/]/).includes('.bin'),
});
writeFileSync(resolve(OUT, 'package.json'), JSON.stringify({ name: 'chrono-synth-sidecar', version: rootPkg.version, private: true, type: 'module' }, null, 2));

/* 5. 清理 staging。 */
rmSync(STAGING, { recursive: true, force: true });

log(`完成：${OUT}`);

/* 6. 便携启动 smoke（--verify）：拷 bundle 到临时目录（模拟 Tauri 资源目录，断开 workspace 符号链接）→ 启动
 *    → 校验 ready 标记 + /readyz。固化「依赖漏装/断链」的自动验收（Codex S1 复审补）。CI/手动可 `--verify`。 */
if (process.argv.includes('--verify')) {
  log('便携启动 smoke（--verify）…');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawn } = await import('node:child_process');
  const tmp = mkdtempSync(join(tmpdir(), 'chrono-sidecar-verify-'));
  cpSync(OUT, tmp, { recursive: true });
  const proc = spawn(process.execPath, [join(tmp, 'dist', 'main-desktop.js')], {
    env: { ...process.env, CHRONO_DB_DRIVER: 'sqlite', CHRONO_DB_PATH: join(tmp, 'verify.db'), CHRONO_QUEUE_ENABLED: 'true', CHRONO_JWT_ENABLED: 'true', CHRONO_JWT_SECRET: 'sidecar-verify-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = null;
  let out = '';
  const done = new Promise((res) => {
    proc.stdout.on('data', (b) => {
      out += b.toString();
      const line = out.split('\n').find((l) => l.startsWith('CHRONO_SIDECAR_READY '));
      if (line && !ready) { ready = JSON.parse(line.slice('CHRONO_SIDECAR_READY '.length)); res(); }
    });
    proc.stderr.on('data', (b) => { out += b.toString(); });
    setTimeout(() => res(), 60_000);
  });
  await done;
  let ok = false;
  if (ready && ready.host === '127.0.0.1' && typeof ready.port === 'number') {
    try {
      const r = await fetch(`http://127.0.0.1:${ready.port}/readyz`);
      const j = await r.json();
      ok = r.ok && j.status === 'ok';
    } catch { /* ok stays false */ }
  }
  proc.kill('SIGTERM');
  rmSync(tmp, { recursive: true, force: true });
  if (!ok) {
    process.stderr.write(`[build-sidecar] ❌ 便携 smoke 失败——bundle 无法独立启动（依赖漏装/断链？）。日志尾:\n${out.slice(-1200)}\n`);
    process.exit(1);
  }
  log(`✓ 便携 smoke 通过（loopback:${ready.port} /readyz ok）`);
} else {
  log('校验：node scripts/build-sidecar.mjs --verify  （便携启动 smoke）');
}
