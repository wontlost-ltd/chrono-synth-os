import { test, expect } from '@playwright/test';
import { mockLoginAndEnter } from './helpers.js';

/**
 * E2E（#115/#116 后续）：语音输入的**错误分支**——权限拒绝 / start() 抛错 / 不支持。
 *
 * voice-perceive.spec.ts 只覆盖 happy path；本 spec 补 useSpeechRecognition 的错误路径（真实 hook，
 * 只 fake 浏览器 SpeechRecognition API）：
 *   1. onerror('not-allowed')（用户拒麦克风权限）→ 中文文案 + 麦克风回 idle、不卡在 listening；
 *   2. start() 同步抛错 → 回滚 + 降级文案；
 *   3. 浏览器不支持 Web Speech → 麦克风隐藏、文字输入仍可用（渐进增强）。
 */

/** fake：start() 后立刻 onerror(code)，模拟权限拒绝/服务不可用。 */
function errorFake(code: string): string {
  return `
    class FakeSpeechRecognition {
      constructor() { this.lang=''; this.continuous=false; this.interimResults=false;
        this.onresult=null; this.onerror=null; this.onend=null; }
      start() {
        /* 真实浏览器：权限拒绝时先 onerror 再 onend。 */
        setTimeout(() => { if (this.onerror) this.onerror({ error: '${code}' }); }, 30);
        setTimeout(() => { if (this.onend) this.onend(); }, 50);
      }
      stop() { if (this.onend) this.onend(); }
      abort() {}
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
  `;
}

/** fake：start() 同步抛错（设备不可用 / 已在识别中）。 */
const THROW_ON_START = `
  class FakeSpeechRecognition {
    constructor() { this.lang=''; this.continuous=false; this.interimResults=false;
      this.onresult=null; this.onerror=null; this.onend=null; }
    start() { throw new Error('cannot start'); }
    stop() {}
    abort() {}
  }
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
`;

/** 移除 Web Speech：模拟 Firefox 等不支持的浏览器。 */
const NO_SPEECH = `
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
`;

async function gotoPerceive(page: import('@playwright/test').Page): Promise<void> {
  await mockLoginAndEnter(page);
  await page.getByRole('tab', { name: '让 TA 听' }).click();
}

test('麦克风权限被拒（not-allowed）→ 中文文案 + 麦克风回到「说」态（不卡 listening）', async ({ page }) => {
  await page.addInitScript(errorFake('not-allowed'));
  await gotoPerceive(page);

  await page.getByRole('button', { name: '点击说给数字人听' }).click();
  /* onerror 后展示权限文案。 */
  await expect(page.getByText('麦克风权限被拒绝，请在浏览器允许后重试。')).toBeVisible({ timeout: 5_000 });
  /* onend 后麦克风回 idle（aria-label 回到「点击说给数字人听」），不卡在「停止说话」。 */
  await expect(page.getByRole('button', { name: '点击说给数字人听' })).toBeVisible();
  /* 文字输入仍可用（降级体验）。 */
  await expect(page.getByLabel('要让数字人感知的经历')).toBeEditable();
});

test('start() 抛错 → 回滚状态 + 降级文案（改用文字输入）', async ({ page }) => {
  await page.addInitScript(THROW_ON_START);
  await gotoPerceive(page);

  await page.getByRole('button', { name: '点击说给数字人听' }).click();
  await expect(page.getByText('无法启动语音识别，请改用文字输入。')).toBeVisible({ timeout: 5_000 });
  /* 没卡在 listening：麦克风仍是「说」态、输入框可编辑。 */
  await expect(page.getByRole('button', { name: '点击说给数字人听' })).toBeVisible();
  await expect(page.getByLabel('要让数字人感知的经历')).toBeEditable();
});

test('浏览器不支持 Web Speech → 麦克风隐藏，文字输入仍可提交（渐进增强）', async ({ page }) => {
  await page.addInitScript(NO_SPEECH);
  await gotoPerceive(page);

  /* 不支持 → 麦克风按钮不渲染。 */
  await expect(page.getByRole('button', { name: '点击说给数字人听' })).toHaveCount(0);
  /* 厂商识别知情提示也不显示（只在 supported 时常驻）。 */
  await expect(page.getByText(/语音识别由你的浏览器提供/)).toHaveCount(0);
  /* 文字输入仍在、可编辑。 */
  await expect(page.getByLabel('要让数字人感知的经历')).toBeEditable();
});
