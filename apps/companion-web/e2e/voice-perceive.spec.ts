import { test, expect } from '@playwright/test';
import { mockLoginAndEnter } from './helpers.js';

/**
 * E2E（#115 验证升级）：语音 ASR → 转写填框 → 提交感知 → 第一人称反馈，在真 chromium 里跑通。
 *
 * chromium 的真 SpeechRecognition 需要真麦克风 + 厂商识别服务（headless 无法稳定驱动），故注入一个
 * **可控的 fake SpeechRecognition**（addInitScript 在 app JS 前装好 window.SpeechRecognition）。
 * fake 模拟真实 onresult 序列（interim→final），驱动**真实的** useSpeechRecognition hook + PerceiveView
 * 接线——验证的是我们的前端逻辑（点麦克风→实时填框→停止→提交），不是浏览器识别引擎本身。
 * /companion/me/perceive 也 mock 掉（不依赖后端），断言第一人称反馈正确渲染。
 */

/** 注入可控 fake SpeechRecognition：start() 后按脚本派发 interim→final，再 onend。 */
const FAKE_SPEECH_INIT = `
  class FakeSpeechRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false;
      this.onresult = null; this.onerror = null; this.onend = null; this._stopped = false; }
    start() {
      this._stopped = false;
      /* 模拟说话：先 interim「今天开会」，再 final「今天开会很累。」 */
      setTimeout(() => {
        if (this._stopped || !this.onresult) return;
        this.onresult({ resultIndex: 0, results: makeResults([{ isFinal: false, t: '今天开会' }]) });
      }, 50);
      setTimeout(() => {
        if (this._stopped || !this.onresult) return;
        this.onresult({ resultIndex: 0, results: makeResults([{ isFinal: true, t: '今天开会很累。' }]) });
      }, 120);
    }
    stop() { this._stopped = true; if (this.onend) this.onend(); }
    abort() { this._stopped = true; }
  }
  function makeResults(items) {
    const arr = items.map((it) => {
      const alt = { transcript: it.t };
      return { isFinal: it.isFinal, length: 1, item: () => alt, 0: alt };
    });
    return { length: arr.length, item: (i) => arr[i], ...arr };
  }
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
`;

test('点麦克风说话 → 转写实时填入输入框 → 提交感知 → 第一人称反馈', async ({ page }) => {
  await page.addInitScript(FAKE_SPEECH_INIT);

  /* mock 感知接口：返回人格「记住了」一条记忆 + 0 待审批。 */
  await page.route('**/api/v1/companion/me/perceive', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          schemaVersion: 'companion-perceive-result.v1',
          perceivedMemories: [{ id: 'm_e2e', content: '今天开会很累。', valence: -0.3, salience: 0.6 }],
          growthCandidateCount: 0,
          pendingApprovalCount: 0,
        },
      }),
    });
  });

  await mockLoginAndEnter(page);

  /* 切到「让 TA 听」tab（perceive）。 */
  await page.getByRole('tab', { name: /让 TA 听|感知/ }).click();

  /* 支持 Web Speech（fake 已注入）→ 麦克风按钮可见。点它开始听。 */
  const mic = page.getByRole('button', { name: /说给数字人听|说/ });
  await expect(mic).toBeVisible();
  await mic.click();

  /* fake 派发 final 后，转写填入输入框。 */
  const textarea = page.getByLabel('要让数字人感知的经历');
  await expect(textarea).toHaveValue(/今天开会很累。/, { timeout: 5_000 });

  /* 停止听（按钮转为「停止」态）→ 提交。 */
  await page.getByRole('button', { name: /停止/ }).click();
  await page.getByRole('button', { name: /让 TA 听|我正在听/ }).click();

  /* 第一人称反馈：「我记住了」+ 记忆内容。 */
  await expect(page.getByText('我记住了')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.perceive__memory')).toContainText('今天开会很累。');
});

test('厂商识别知情提示常驻（诚实红线：浏览器可能云端识别）', async ({ page }) => {
  await page.addInitScript(FAKE_SPEECH_INIT);
  await mockLoginAndEnter(page);
  await page.getByRole('tab', { name: /让 TA 听|感知/ }).click();
  /* 支持语音时常驻一行知情提示——不宣称「音频不离开设备」。 */
  await expect(page.getByText(/语音识别由你的浏览器提供.*Chrono 只接收转写后的文字/)).toBeVisible();
});
