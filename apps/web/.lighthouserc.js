/** @type {import('@lhci/utils/src/types').LhrFlowConfig} */
module.exports = {
  ci: {
    collect: {
      startServerCommand: 'npm run preview',
      startServerReadyPattern: 'Local',
      startServerReadyTimeout: 30000,
      url: [
        'http://localhost:4173/login',
        'http://localhost:4173/register',
      ],
      numberOfRuns: 1,
      settings: {
        chromeFlags: '--no-sandbox --disable-dev-shm-usage',
        // 模拟移动端节流，与 Pixel 5 playwright 项目对齐
        emulatedFormFactor: 'mobile',
        throttlingMethod: 'simulate',
      },
    },
    assert: {
      preset: 'lighthouse:no-pwa',
      assertions: {
        'categories:performance': ['warn', { minScore: 0.8 }],
        // P1.3：a11y 阈值从 0.9 → 0.95，对齐 enterprise-readiness 计划
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'categories:best-practices': ['warn', { minScore: 0.85 }],
        'categories:seo': ['warn', { minScore: 0.8 }],
        // 关键 a11y 规则强制通过
        'color-contrast': 'error',
        'document-title': 'error',
        'html-has-lang': 'error',
        'image-alt': 'error',
        'label': 'error',
        'meta-viewport': 'error',
        // P1.3 新增：交互元素必须有可达名称、focus order 合理、ARIA 属性正确
        'button-name': 'error',
        'link-name': 'error',
        'aria-valid-attr': 'error',
        'aria-valid-attr-value': 'error',
        'duplicate-id-active': 'error',
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
