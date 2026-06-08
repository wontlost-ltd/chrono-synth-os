# a11y Runbook (chrono-synth-web)

> 当 `.github/workflows/e2e.yml` 的 `a11y` job 失败时如何应对。
> 该 runbook 与 `security-ci-runbook.md` 同源风格，跟 `chrono-synth-os/docs/operations/slo-runbook.md` 列在同一个 operations 索引下。

## 目标 — WCAG 2.1 AA

每个 PR 触发一遍 axe-core/playwright 跑全 SPA 关键路径。Critical + Serious 违规
**硬 fail PR**；Moderate + Minor 违规走 `expect.soft` 进 playwright report，不阻塞但
留痕。

具体 13 个 route 在 `e2e/accessibility/axe-routes.spec.ts` 的 `ROUTES` 数组里：

| 类别 | 路由 |
|---|---|
| Unauth public | `/login`, `/register` |
| User-facing core | `/dashboard`, `/onboarding`, `/simulations/:id/paths` |
| P0.4 i18n 重点 | `/admin/{tool-permissions,agency-authorizations,tool-invocations,safety/drift}`, `/agent/{oauth/google,confirmations}` |
| Account | `/billing`, `/settings` |

## 严重度门槛策略

axe-core 把违规分四级：

| Impact | 处理 | 出现时 PR 状态 |
|---|---|---|
| **critical** | 硬 fail | ❌ blocked |
| **serious**  | 硬 fail | ❌ blocked |
| **moderate** | `expect.soft` | ✅ 通过但 report 留痕 |
| **minor** | `expect.soft` | ✅ 通过但 report 留痕 |

设计意图：用户实际无法使用的（关键交互无可达名、focus trap 锁住、
aria-required 属性缺失）必须立即修；视觉性、信息型的渐进改进允许在
不阻塞 main 的前提下批次落地。

`ROUTES` 数组所有 13 条**当前 baseline 是 0 blocking + 0 advisory**（2026-05-09
最新 main）。任何 PR 让 advisory 数量上升到 ≥1 都会在 playwright-report
里看到 soft 失败堆栈，可作为 follow-up 工作单。

## 选型注脚 — playwright-axe (不是 vitest-axe)

执行计划 EP-2.2 原写"vitest-axe in `src/test/a11y/`"。**有意识偏离**为
`@axe-core/playwright`，原因：

- vitest-axe 跑在 jsdom，**没有真实 layout 或 paint 引擎**。多个 axe 规则
  在 jsdom 下不可靠：
  - **color-contrast**：jsdom 返回的 computed style 是合成值，反映 Tailwind
    class 字符串而非真实 RGB 像素 → 大量 false positive / false negative
  - **focus-visible / focus-order**：jsdom 的 focus 模拟跳过若干真浏览器
    invariants（如 modal portal 里的 tab trap）
  - **aria-live region**：jsdom 不会像辅助技术一样宣告 mutations
- Playwright + Chromium 跑 axe 抓到的是真实用户感知的违规
- 代价：每条 route ~1s（vs jsdom ~50ms）。13 routes 总耗时 ~5s，CI 上
  PR + push 可接受

完整 rationale 也在 `e2e/accessibility/axe-routes.spec.ts` 顶部 docstring。

## 本地复现

```bash
# 全套 a11y suite（4 个 spec 文件 / 24 tests / ~5s）
npx playwright test --project=chromium e2e/accessibility/ e2e/axe-a11y.spec.ts e2e/a11y.spec.ts

# 只跑新增 13 routes 的 axe 扫描
npx playwright test --project=chromium e2e/accessibility/axe-routes.spec.ts

# 看 HTML 报告（含 advisory soft-fail 的 stack）
npx playwright show-report
```

## a11y job 失败排查

### 第一步：找哪条 route 哪条规则

```bash
# CI artifact: a11y-report (14 天保留)
# 解压后打开 playwright-report/index.html
# 失败的 spec 显示完整 axe violation 栈：
#   [critical] color-contrast: Elements must have sufficient color contrast
#     <button class="text-text-secondary bg-surface">...</button>
#   helpUrl: https://dequeuniversity.com/rules/axe/4.x/color-contrast
```

### 第二步：判断是真违规还是 false positive

**真违规**——必须修：
- 缺 `aria-label` 或 `<label>` 关联：加 i18n key 后用 `t('...')` 提供
- 颜色对比 < 4.5:1（normal text）/ 3:1（large text / UI）：调
  `tailwind.config` 或 `src/styles/globals.css` 的 token
- 重复 ID：通常来自 React 同组件多实例，加 `useId()` 修
- 缺 button/link 名：visible text 或 `aria-label`

**False positive**——通常是：
- axe 把 i18n loading 状态识别为 missing label（应当用 `Suspense`
  fallback 屏蔽）
- skeleton loader 触发 region rule（已用 `disableRules(['region'])`
  对策）

### 第三步：临时 disable 单条规则

如果某条规则确实跟我们的 component pattern 冲突且短期无法修：

```ts
const results = await new AxeBuilder({ page })
  .withTags(['wcag2a', 'wcag2aa'])
  .disableRules(['rule-id'])  // 加在这里 + 写注释说明原因 + 跟 issue
  .analyze();
```

**绝对禁止**：删除整条 ROUTES entry 来"绕过"违规。如果某条 route
真的不能通过 a11y，必须开 issue 跟踪 + 写到 PR 描述里。

## 已知缺口 — Skip-link

WCAG 2.4.1 (Level A) 要求"Bypass Blocks"。本 SPA **目前没有全局 skip-link**
（"Skip to main content"）。

axe-core 的 `bypass` rule 不会 fail，因为我们已经用 `<nav>` + `<main>` 等
HTML5 landmarks 作为替代——axe 认为 landmarks 满足 bypass 要求。
**但 enterprise 级 a11y 评估通常仍期望显式 skip-link**。

实现计划：**留给 EP-2.4 设计系统 PR**。skip-link 是 layout/design-system
范畴，与 onboarding 流程 + 全局 AppShell 重构同源，单独做不经济。

跟踪：执行计划 EP-2.4 "现代化设计系统 + 首次使用引导"。

## Lighthouse a11y 阈值

`.lighthouserc.js` 单独跑 `npm run lhci`，与 axe 互补：

- `categories:accessibility` minScore **0.95**（错误，硬 fail）
- 关键规则强制：`color-contrast` / `document-title` / `html-has-lang`
  / `image-alt` / `label` / `meta-viewport` / `button-name` / `link-name`
  / `aria-valid-attr` / `aria-valid-attr-value` / `duplicate-id-active`

axe 是 PR-time CI gate；Lighthouse 是定期手动跑 + 发布前必须通过。

## 修改严重度门槛的流程

不要随便降到只警告。每次需要：
1. 在 PR 描述中说明为什么（避免暗中放水）
2. 同时改 `e2e/accessibility/axe-routes.spec.ts` 的 `blocking.filter` 逻辑
3. 同步本 runbook 的"严重度门槛策略"表
4. 至少 1 个 reviewer
