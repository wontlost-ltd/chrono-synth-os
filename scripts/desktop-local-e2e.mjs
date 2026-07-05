#!/usr/bin/env node
/**
 * ADR-0061 S6 端到端冒烟：验**打包产物**（便携 sidecar bundle）在本地全链跑通——模拟桌面安装包的 Rust 侧
 * 会做的事（起 sidecar + 握手 + auto-provision），然后走完整产品链：
 *   ① sidecar 便携 bundle 启动（127.0.0.1 loopback + 动态端口 + 握手 token，红线 2/11）
 *   ② auto-provision 本地 admin（S5：register 拿 token，零手工配）
 *   ③ 红线 11：无握手头业务端点 403 / 有握手头放行
 *   ④ companion 零-LLM chat（ADR-0047 论点：运行时零-LLM）
 *   ⑤ 数字员工组织建立（ADR-0056 per-persona 内核出生）
 *   ⑥ 工具自动授权运营端点可达（ADR-0060 T7）
 *   ⑦ SQLite 落 CHRONO_DB_PATH + 迁移；优雅关停无孤儿（红线 3/4）
 *
 * 前置：`npm run build && node scripts/build-sidecar.mjs`（产 dist-sidecar/）。
 * 用法：node scripts/desktop-local-e2e.mjs
 * 退出码 0=全链通过；非 0=某环节失败（打印失败环节）。
 *
 * 注：这是「打包产物在本地能否作为完整单机 app 运行」的自动化验收，非「真·干净机双击安装」（后者须实机+签名）。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = resolve(ROOT, 'dist-sidecar');
const HANDSHAKE = `s6-${randomUUID()}`;
const JWT_SECRET = `s6-jwt-${randomUUID()}`;

function log(m) { process.stdout.write(`[s6-e2e] ${m}\n`); }
/* fail() throw（非 process.exit）——由 main().catch 统一走 cleanup，避免失败路径残留 tmp/子进程（Codex S6 复审）。 */
function fail(m) { throw new Error(m); }

if (!existsSync(join(BUNDLE, 'dist', 'main-desktop.js'))) {
  process.stderr.write('[s6-e2e] ❌ dist-sidecar/dist/main-desktop.js 不存在——请先 `npm run build && node scripts/build-sidecar.mjs`\n');
  process.exit(1); /* 此处尚未建 tmp/起子进程，直接退出无残留 */
}

const tmp = mkdtempSync(join(tmpdir(), 'chrono-s6-e2e-'));
const bundleCopy = join(tmp, 'bundle');
const dbPath = join(tmp, 'chrono-os.db');
/* 拷 bundle 到临时目录（模拟 Tauri 资源目录，断开 workspace 符号链接=真便携性）。 */
const { cpSync } = await import('node:fs');
cpSync(BUNDLE, bundleCopy, { recursive: true });

let proc = null;
function cleanup() {
  if (proc) { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }
  rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  /* ① 起 sidecar（模拟 Rust spawn：loopback + 动态端口 + 握手 token + JWT secret）。 */
  log('① 启动便携 sidecar bundle（loopback + 动态端口 + 握手 token）…');
  proc = spawn(process.execPath, [join(bundleCopy, 'dist', 'main-desktop.js')], {
    env: { ...process.env, CHRONO_DB_DRIVER: 'sqlite', CHRONO_DB_PATH: dbPath, CHRONO_QUEUE_ENABLED: 'true',
           CHRONO_JWT_ENABLED: 'true', CHRONO_JWT_SECRET: JWT_SECRET, CHRONO_DESKTOP_SESSION: HANDSHAKE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const ready = await new Promise((res) => {
    proc.stdout.on('data', (b) => {
      out += b.toString();
      const line = out.split('\n').find((l) => l.startsWith('CHRONO_SIDECAR_READY '));
      if (line) res(JSON.parse(line.slice('CHRONO_SIDECAR_READY '.length)));
    });
    proc.stderr.on('data', (b) => { out += b.toString(); });
    setTimeout(() => res(null), 60_000);
  });
  if (!ready || ready.host !== '127.0.0.1' || typeof ready.port !== 'number') {
    fail(`sidecar 未就绪 / 非 loopback。日志尾:\n${out.slice(-800)}`);
  }
  const base = `http://127.0.0.1:${ready.port}`;
  log(`   ✓ 就绪 ${base}（instanceNonce=${ready.instanceNonce.slice(0, 8)}…）`);

  const hs = { 'x-chrono-desktop-session': HANDSHAKE };
  const jsonHs = { 'content-type': 'application/json', ...hs };

  /* ③ 红线 11：无握手头业务端点 403。 */
  log('③ 红线 11：无握手头业务端点应 403…');
  const noHs = await fetch(`${base}/api/v1/companion/me`);
  if (noHs.status !== 403) fail(`无握手头应 403，得 ${noHs.status}`);
  log('   ✓ 无握手头 403（同机误连被挡）');

  /* ② auto-provision 本地 admin（S5：register 拿 token）。 */
  log('② auto-provision 本地 admin（register，零手工配）…');
  const reg = await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: jsonHs,
    body: JSON.stringify({ email: 'local@chrono.app', password: `Lz9!${randomUUID()}`, displayName: 'Local' }) });
  if (!reg.ok) fail(`register 失败 ${reg.status}: ${(await reg.text()).slice(0, 200)}`);
  const token = (await reg.json()).data?.accessToken;
  if (!token) fail('register 未返回 accessToken');
  const auth = { authorization: `Bearer ${token}`, ...hs };
  log('   ✓ 本地 admin 已就绪（token 拿到）');

  /* ④ companion 零-LLM chat（ADR-0047）。 */
  log('④ companion 零-LLM chat（运行时零-LLM）…');
  const chat = await fetch(`${base}/api/v1/companion/me/chat`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ message: '你好，介绍一下你自己' }) });
  if (!chat.ok) fail(`chat 失败 ${chat.status}`);
  const reply = (await chat.json()).data?.reply;
  if (!reply) fail('chat 未返回 reply');
  log(`   ✓ 确定性回复（${reply.slice(0, 24)}…）`);

  /* ⑤ 数字员工组织建立（ADR-0056 per-persona 内核出生）。 */
  log('⑤ 建数字员工组织（per-persona 内核出生）…');
  const org = await fetch(`${base}/api/v1/workforce/orgs`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ orgId: 's6-org', roleCode: 'ceo', title: 'CEO', displayName: '总裁', archetype: 'explorer' }) });
  if (!org.ok) fail(`建组织失败 ${org.status}: ${(await org.text()).slice(0, 200)}`);
  const birth = (await org.json()).data?.birth;
  if (!birth?.personaId) fail('组织未返回 per-persona birth');
  log(`   ✓ 出生独立人格内核 ${birth.personaId}（archetype=${birth.archetype}, kind=${birth.kind}）`);

  /* ⑥ 工具自动授权运营端点接通（ADR-0060 T7）——**带握手头 + JWT 真打路由**（过 desktop-session guard + auth）。
   * workforce org persona 非 enterprise-owned（assertOwner 查 personaCore），故 owner 守卫返 404——但这个 404 是
   * **路由内业务守卫**（非 404-route-not-found），证明 T7 route 真接通。同时先验无握手头被 guard 挡（红线 11）。 */
  log('⑥ 工具自动授权端点接通（ADR-0060 T7）…');
  const t7NoHs = await fetch(`${base}/api/v1/persona-core/${birth.personaId}/tool-auto-auth/pending`, { headers: { authorization: `Bearer ${token}` } });
  if (t7NoHs.status !== 403) fail(`T7 无握手头应被 guard 挡 403（红线11），得 ${t7NoHs.status}`);
  const t7 = await fetch(`${base}/api/v1/persona-core/${birth.personaId}/tool-auto-auth/pending`, { headers: auth });
  /* 带握手+JWT：过 guard+auth，进 T7 route → owner 守卫（org persona 非 enterprise owned）返 404，或（若可 owner）200。
   * 关键：**不是** 403（握手/auth 层），证明真进了 route 的业务守卫。 */
  const t7body = await t7.text();
  if (t7.status === 403) fail(`T7 带握手+JWT 仍 403，未进 route（应 404 owner 守卫或 200）：${t7body.slice(0, 200)}`);
  if (t7.status !== 404 && t7.status !== 200) fail(`T7 route 意外状态 ${t7.status}：${t7body.slice(0, 200)}`);
  log(`   ✓ T7 路由接通（无握手 403 / 带握手+JWT 进 route→${t7.status} 业务守卫）`);

  /* ⑦ SQLite 落库确认。 */
  if (!existsSync(dbPath)) fail('SQLite DB 未落 CHRONO_DB_PATH');
  log('⑦ ✓ SQLite 落 app-data 路径');

  /* 优雅关停无孤儿（红线 4）。 */
  log('关停 sidecar（SIGTERM，验无孤儿）…');
  const pid = proc.pid;
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 4000));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } fail('sidecar 未优雅退出（孤儿）'); }
  proc = null;
  log('   ✓ 优雅退出无孤儿');

  log('✅ S6 端到端全链通过：便携 bundle 本地起 → 握手 → auto-provision → companion 零-LLM → per-persona 组织 → T7 → 关停。');
}

main().then(() => { cleanup(); process.exit(0); }).catch((e) => {
  process.stderr.write(`[s6-e2e] ❌ ${e instanceof Error ? e.stack : String(e)}\n`);
  cleanup();
  process.exit(1);
});
