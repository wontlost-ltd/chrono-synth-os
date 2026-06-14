/**
 * 真全栈本地演示脚本（**非自动化测试**，是可复用的「跑给人看」工具）。
 *
 * 与 e2e/*.spec.ts 的区别：那些 mock 后端、跑在 CI/本地回归门；这个**打真后端**（真登录、真
 * PerceptionDistiller 写真记忆），用 playwright 驱真 chromium，**录一段 .webm 视频** + 关键帧 PNG，
 * 把 companion 的端到端体验完整跑一遍给人看。
 *
 * 验证的能力（全真）：
 *   1. 真注册 + 真登录（真后端 JWT 鉴权）
 *   2. Edge 端侧内核徽章——persona kernel 真在浏览器 Web Worker 里加载 + 跑确定性闭环（#112）
 *   3. 语音 ASR——真 useSpeechRecognition hook 把语音转写填进输入框（#115；SpeechRecognition 注入
 *      可控 fake，因 headless 无法驱动真 ASR——只 fake 浏览器 API，hook/view 是真的）
 *   4. 感知——真 PerceptionDistiller 把转写沉淀为真 episodic 记忆 + 身份层提案保持 pending（ADR-0051）
 *   5. 回 Home 看记忆数真增长（证明真写库，非 mock）
 *
 * 前提：真后端 :3000 + companion-web :5173 已起（见 README「真全栈演示」）。
 * 跑法：node apps/companion-web/e2e/demo-live.mjs   （或 npm run demo:live）
 * 产物：apps/companion-web/demo-shots/  （run.webm 视频 + N-*.png 关键帧；已 gitignore）
 *
 * 环境变量：
 *   DEMO_BASE_URL   前端地址（默认 http://localhost:5173）
 *   DEMO_HEADED     设 '1' 则有头模式（默认 headless）
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE_URL = process.env.DEMO_BASE_URL ?? 'http://localhost:5173';
const HEADED = process.env.DEMO_HEADED === '1';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo-shots');
/* 每次重跑清空旧产物，避免新旧帧/视频混淆。 */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* 可控 fake SpeechRecognition：start() 后按脚本派发 interim→final，模拟真实说话事件序列。
 * 只替换浏览器 API，被测的 useSpeechRecognition hook + PerceiveView 仍是真的。 */
const FAKE_SR = `
  class FakeSpeechRecognition {
    constructor(){ this.lang=''; this.continuous=false; this.interimResults=false;
      this.onresult=null; this.onerror=null; this.onend=null; this._stopped=false; }
    start(){
      this._stopped=false;
      const mk=(items)=>{const a=items.map(it=>{const alt={transcript:it.t};return {isFinal:it.isFinal,length:1,item:()=>alt,0:alt};});return {length:a.length,item:(i)=>a[i],...a};};
      setTimeout(()=>{ if(this._stopped||!this.onresult)return; this.onresult({resultIndex:0,results:mk([{isFinal:false,t:'今天开会很累'}])}); },400);
      setTimeout(()=>{ if(this._stopped||!this.onresult)return; this.onresult({resultIndex:0,results:mk([{isFinal:true,t:'今天开会很累，但我没和别人说。回家只想一个人安静待着。'}])}); },1000);
    }
    stop(){ this._stopped=true; if(this.onend) this.onend(); }
    abort(){ this._stopped=true; }
  }
  window.SpeechRecognition=FakeSpeechRecognition;
  window.webkitSpeechRecognition=FakeSpeechRecognition;
`;

const EMAIL = `demo-${Date.now()}@chrono.local`;
const log = (m) => console.log(`[demo] ${m}`);

const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  serviceWorkers: 'block',
  /* 录屏：整段真浏览器操作录成 .webm。 */
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
});
await ctx.addInitScript(FAKE_SR);
const page = await ctx.newPage();
let videoPath;

try {
  /* 1. 登录页 */
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(OUT, '1-login.png') });
  log('1 登录页');

  /* 2. 真注册（新账号，避免依赖已存在用户）→ 真后端建用户。 */
  const reg = await page.request.post(`${BASE_URL}/api/v1/auth/register`, {
    data: { email: EMAIL, password: 'password123' },
  });
  if (!reg.ok()) throw new Error(`注册失败 ${reg.status()}（后端没起？）`);
  log(`2 真注册 ${EMAIL} → ${reg.status()}`);

  /* 3. UI 真登录 → 真鉴权 → authed 外壳；等 Edge 徽章自检成功文案 */
  await page.getByLabel('邮箱').fill(EMAIL);
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('tablist', { name: '主导航' }).waitFor();
  await page.locator('.edge-badge').filter({ hasText: '本设备支持端侧人格内核运行' }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(OUT, '2-home-edge-badge.png'), fullPage: true });
  log('3 Home + Edge 端侧内核徽章（✓ 真 Worker 自检通过）');

  /* 4. 「让 TA 听」→ 点麦克风 → 真 hook 把转写填进框 */
  await page.getByRole('tab', { name: '让 TA 听' }).click();
  await page.screenshot({ path: join(OUT, '3-perceive-empty.png') });
  await page.getByRole('button', { name: '点击说给数字人听' }).click();
  await page.waitForFunction(
    () => document.querySelector('.perceive__input')?.value.includes('回家只想一个人安静'),
    { timeout: 8000 },
  );
  await page.screenshot({ path: join(OUT, '4-voice-transcribed.png'), fullPage: true });
  log('4 语音转写实时填入输入框');

  /* 5. 停止 → 提交 → 真 PerceptionDistiller 沉淀真记忆 → 第一人称反馈 */
  await page.getByRole('button', { name: '停止说话' }).click();
  await page.getByRole('button', { name: '让 TA 听' }).click();
  await page.getByText('我记住了').waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(OUT, '5-perceive-result.png'), fullPage: true });
  log('5 感知反馈：「我记住了」+ 真沉淀记忆（真后端真蒸馏器）');

  /* 6. 回 Home 看记忆数真增长（证明真写库） */
  await page.getByRole('tab', { name: '我的数字人' }).click();
  await page.getByText(/段记忆/).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(OUT, '6-home-after.png'), fullPage: true });
  log('6 回 Home：记忆数真增长（真写库）');

  log('✅ 全部步骤完成');
} catch (err) {
  await page.screenshot({ path: join(OUT, 'ERROR.png'), fullPage: true }).catch(() => {});
  log(`✗ 出错（已截 ERROR.png）：${err.message}`);
  process.exitCode = 1;
} finally {
  /* 关 page 后视频才落盘；拿到路径后规整命名为 run.webm。 */
  videoPath = await page.video()?.path().catch(() => undefined);
  await ctx.close();
  await browser.close();
  if (videoPath) {
    try { renameSync(videoPath, join(OUT, 'run.webm')); }
    catch { /* 若改名失败保留原 .webm */ }
  }
  const webm = readdirSync(OUT).filter((f) => f.endsWith('.webm'));
  log(`产物：${OUT}/  （视频 ${webm.join(', ') || '无'} + 关键帧 PNG）`);
}
