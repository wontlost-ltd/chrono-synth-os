# 人格出生多样性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除"同原型 persona 出生逐字节相同"缺陷——workforce 出生加 per-persona 扰动（seed=personaId）+ 内核 hashSeed 32→64 位 + deliberationDepth 整数维也拉开，全在 isPristine 守卫内，现有人格零漂移。

**Architecture:** 改内核纯函数 `perturbDecisionStyle`（64 位 BigInt hash + 整数维缩放 2→10）先落，再让 workforce `birthPersona` 调它。TDD：先补内核测试→改内核→重建 kernel dist→再改 workforce→workforce 测试。

**Tech Stack:** TypeScript (ESM, `.js` 后缀)，`node:test` + `node:assert/strict`，`@chrono/kernel`（纯函数内核，改后须 `tsc -b packages/kernel --force`），`personalityDiversity` 度量。

## Global Constraints

- 注释/文档简体中文（意图/约束/用法）。
- 内核可复现铁律：不用 `Date.now()`/`Math.random()`；`perturbDecisionStyle` 是纯函数，时间/种子由调用方注入。
- ESM：相对导入带 `.js`；跨包用 `@chrono/kernel`。
- 三处改动均在 `isPristine` 守卫内，**不改变已落库人格**；可复现（同 personaId+同 magnitude→同结果）不破。
- **改 kernel 后必须 `tsc -b packages/kernel --force` 重建 dist**，否则测试跑旧实现假绿。
- `deliberationDepth` 恒 ∈ [1,5] 整数；`magnitude=0` 恒等 base（向后兼容）。
- 本地验证强制，失败即止。

---

### Task 1: 内核 `perturbDecisionStyle` — 64 位 hash + 整数维拉开

**Files:**
- Modify: `packages/kernel/src/domain/core-self/decision-style-perturbation.ts`（第 22 行常量区、第 56-60 行 deliberationDepth、第 68-77 行 hashSeed）
- Test: `packages/kernel/test/decision-style-perturbation.test.ts`（既有文件，增补断言）

**Interfaces:**
- Consumes: 无新增（同签名 `perturbDecisionStyle(base, seed, magnitude, now)`）。
- Produces: 行为变化——`hashSeed` 输出分布更宽（64 位）；`deliberationDepth` 在非零 magnitude 下真分散。签名不变。

- [ ] **Step 1: 增补失败测试**

在 `packages/kernel/test/decision-style-perturbation.test.ts` 的 `describe` 块内、末尾 `});` 之前追加两个测试：

```ts
  it('deliberationDepth 在 magnitude=0.15 下真拉开（补齐第 6 维）', () => {
    const depths = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const r = perturbDecisionStyle(BASE, `persona_${i}`, 0.15, 1000);
      assert.ok(r.deliberationDepth >= 1 && r.deliberationDepth <= 5 && Number.isInteger(r.deliberationDepth));
      depths.add(r.deliberationDepth);
    }
    /* 修复前恒为单一值（BASE.deliberationDepth=3）；修复后应出现 ≥2 个不同取值。 */
    assert.ok(depths.size >= 2, `deliberationDepth 应分散，实际取值集=${[...depths]}`);
  });

  it('magnitude=0 时 deliberationDepth 恒等 base（向后兼容，含整数维缩放改动后仍成立）', () => {
    for (let i = 0; i < 20; i++) {
      const r = perturbDecisionStyle(BASE, `persona_${i}`, 0, 1000);
      assert.equal(r.deliberationDepth, BASE.deliberationDepth);
    }
  });
```

- [ ] **Step 2: 重建 kernel + 跑测试确认失败**

Run:
```bash
npx tsc -b packages/kernel --force >/dev/null 2>&1
node --test --test-force-exit packages/kernel/dist-test/test/decision-style-perturbation.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: FAIL —— 新加的 "deliberationDepth 真拉开" 断言失败（旧 ×2 缩放下 depths.size===1）。

- [ ] **Step 3: 改内核实现**

3a. 在常量区（第 22 行 `const DELIBERATION_MIN...` 之后）加整数维缩放常量：

```ts
/** 整数维（deliberationDepth）扰动缩放：float 维用 ±mag，整数维需更大缩放才能在 5 档整数上产生 ±1~2
 * 分散（mag=0.15、×10 时 base=3 → 分布 {2,3,4}）。×2（旧值）在 0.15 下 round 恒回 base，整数维不动。 */
const INT_DIM_SCALE = 10;
```

3b. 把 deliberationDepth 那段（第 56-60 行）：

```ts
    /* deliberationDepth（1..5 整数）：base ± round(mag×2)，clamp 到 [1,5]。 */
    deliberationDepth: clampInt(
      Math.round(base.deliberationDepth + jitter('deliberationDepth') * mag * 2),
      DELIBERATION_MIN, DELIBERATION_MAX,
    ),
```

改为（缩放 2→INT_DIM_SCALE）：

```ts
    /* deliberationDepth（1..5 整数）：base ± round(mag×INT_DIM_SCALE)，clamp 到 [1,5]。
     * mag=0 时 jitter×0×SCALE=0 → 恒等 base（向后兼容）。 */
    deliberationDepth: clampInt(
      Math.round(base.deliberationDepth + jitter('deliberationDepth') * mag * INT_DIM_SCALE),
      DELIBERATION_MIN, DELIBERATION_MAX,
    ),
```

3c. 把 `hashSeed`（第 67-77 行）从 32 位换成 64 位 BigInt FNV-1a：

```ts
/** FNV-1a 64-bit 哈希 → [0,1)。同字符串恒得同值（确定性）。64 位使扰动值空间从 ~4.3e9 提升到 ~1.8e19，
 * 大规模出生种子碰撞降到可忽略。纯 BigInt、无依赖；出生低频调用，BigInt 开销无关紧要。 */
function hashSeed(s: string): number {
  const MASK = 0xFFFFFFFFFFFFFFFFn;         // 64 位掩码
  const PRIME = 0x100000001b3n;             // FNV-1a 64 位 prime
  let h = 0xcbf29ce484222325n;              // FNV-1a 64 位 offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  /* 无符号 64 位 → [0,1)。2^64 = 0x1_0000_0000_0000_0000。 */
  return Number(h) / 18446744073709551616;
}
```

- [ ] **Step 4: 重建 kernel + 跑测试确认通过**

Run:
```bash
npx tsc -b packages/kernel --force >/dev/null 2>&1; echo "kernel build exit=$?"
node --test --test-force-exit packages/kernel/dist-test/test/decision-style-perturbation.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: kernel build exit=0；全部测试 PASS（含新增 2 个 + 既有全部，尤其"magnitude=0 不扰动"与"结果合法"仍绿）。

- [ ] **Step 5: 内核相邻回归**

Run:
```bash
node --test --test-force-exit \
  packages/kernel/dist-test/test/personality-diversity.test.js \
  packages/kernel/dist-test/test/personality-archetypes.test.js \
  2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: 全绿（这两个不依赖 hashSeed 具体值，只依赖合法性/结构，不应回归）。

- [ ] **Step 6: 提交**

```bash
git add packages/kernel/src/domain/core-self/decision-style-perturbation.ts packages/kernel/test/decision-style-perturbation.test.ts
git commit -m "$(printf 'feat(kernel): 出生扰动 hashSeed 32→64 位 + deliberationDepth 拉开\n\nhashSeed 32→64 位 BigInt FNV-1a（扰动值空间 4.3e9→1.8e19，降碰撞）；\ndeliberationDepth 整数维缩放 2→INT_DIM_SCALE=10（0.15 幅度下真分散，\nbase=3→{2,3,4}）。magnitude=0 仍恒等 base，isPristine 守卫下不动现有人格。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: workforce `birthPersona` 加 per-persona 扰动

**Files:**
- Modify: `src/workforce/workforce-persona-bootstrap-service.ts`（第 21 行 import、接口区附近加常量、第 114 行出生写入）
- Modify: `src/test/integration/workforce-persona-bootstrap-k4.test.ts`（**既有测试第 74 行断言必须翻转**——见 Step 1b）
- Test: `src/test/integration/persona-birth-perturbation.test.ts`（新增，与 k4 测试同目录/同 setup 风格）

**Interfaces:**
- Consumes: `perturbDecisionStyle`（`@chrono/kernel`，Task 1 已改）、`archetypeDecisionStyle`（既有）、`personalityDiversity`（`@chrono/kernel`，度量）、`OrgWorkforceStore`/`OrgChartService`/`TestClock`（构造 bootstrap）。
- Produces: `birthPersona` 出生态从"纯原型"变为"原型+personaId 扰动"；对外行为（返回 `PersonaBirthOutcome`）不变。

**⚠️ 破坏性：既有测试 `workforce-persona-bootstrap-k4.test.ts:74`** 断言"同原型两实例出生风格 `deepEqual`"——本改动**故意让它不再相等**（同原型不同 personaId 现在不同）。Step 1b 必须翻转该断言，否则回归红。

- [ ] **Step 1a: 写新增失败测试**（镜像 k4 测试的真实 setup：`OrgWorkforceStore` + `TestClock` + 完整 `WorkerSpec` 字段）

创建 `src/test/integration/persona-birth-perturbation.test.ts`：

```ts
/**
 * 出生 per-persona 扰动：同原型、不同 personaId 的 worker 出生即被拉开（消除"同原型逐字节相同"）。
 * 与 workforce-persona-bootstrap-k4 同 setup（OrgWorkforceStore + TestClock）。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService } from '../../workforce/org-chart-service.js';
import { WorkforcePersonaBootstrapService, type WorkerPersonaSpec } from '../../workforce/workforce-persona-bootstrap-service.js';
import { personalityDiversity } from '@chrono/kernel';
import type { DecisionStyle } from '@chrono/kernel';

/** 建 N 个同原型（analyst）、不同 personaId 的 worker spec（单根 + 其余挂根，满足结构校验）。 */
function analystPod(n: number): WorkerPersonaSpec[] {
  const specs: WorkerPersonaSpec[] = [];
  for (let i = 0; i < n; i++) {
    specs.push({
      roleCode: `a${i}`, title: '分析师', jobFamily: 'ic', seniority: 'ic',
      displayName: `分析${i}`, personaId: `p-analyst-${i}`,
      managerRoleCode: i === 0 ? null : 'a0', archetype: 'analyst',
    });
  }
  return specs;
}

describe('workforce 出生 per-persona 扰动', () => {
  let os: ChronoSynthOS;
  let svc: WorkforcePersonaBootstrapService;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(1000);
    os = new ChronoSynthOS({ clock, logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    const store = new OrgWorkforceStore(os.getDatabase(), 't1');
    let c = 0;
    const chart = new OrgChartService(store, () => clock.now(), () => `id-${++c}`);
    svc = new WorkforcePersonaBootstrapService(os, chart, () => clock.now());
  });

  it('同原型、不同 personaId → 出生决策风格被拉开（diversityScore>0）', () => {
    svc.bootstrap('org-div', analystPod(8));
    const styles: DecisionStyle[] = [];
    for (let i = 0; i < 8; i++) styles.push(os.getCore(`p-analyst-${i}`).decisionStyle.get());
    const div = personalityDiversity(styles);
    assert.ok(div.diversityScore > 0, `同原型出生应被扰动拉开，实际 diversityScore=${div.diversityScore}`);
    /* 至少两个 persona 的 deliberationDepth 也不同（补齐第 6 维已生效）。 */
    const depths = new Set(styles.map((s) => s.deliberationDepth));
    assert.ok(depths.size >= 2, `deliberationDepth 也应分散，实得 ${[...depths]}`);
  });

  it('同 personaId 出生可复现：两个独立 OS 出生同 personaId → 决策风格逐字段相同', () => {
    svc.bootstrap('org-a', [{ roleCode: 'r', title: '分析', jobFamily: 'ic', seniority: 'ic', displayName: 'x', personaId: 'p-repro', managerRoleCode: null, archetype: 'analyst' }]);
    const first = os.getCore('p-repro').decisionStyle.get();

    const clock2 = new TestClock(1000);
    const os2 = new ChronoSynthOS({ clock: clock2, logger: new SilentLogger(), tenantId: 't2' });
    os2.start();
    const store2 = new OrgWorkforceStore(os2.getDatabase(), 't2');
    let c = 0;
    const chart2 = new OrgChartService(store2, () => clock2.now(), () => `id-${++c}`);
    const svc2 = new WorkforcePersonaBootstrapService(os2, chart2, () => clock2.now());
    svc2.bootstrap('org-a', [{ roleCode: 'r', title: '分析', jobFamily: 'ic', seniority: 'ic', displayName: 'x', personaId: 'p-repro', managerRoleCode: null, archetype: 'analyst' }]);
    const second = os2.getCore('p-repro').decisionStyle.get();

    assert.deepEqual(
      { r: first.riskAppetite, t: first.timeHorizon, e: first.explorationBias, d: first.deliberationDepth, l: first.lossAversion, g: first.regretSensitivity },
      { r: second.riskAppetite, t: second.timeHorizon, e: second.explorationBias, d: second.deliberationDepth, l: second.lossAversion, g: second.regretSensitivity },
    );
    os2.close();
  });
});
```

- [ ] **Step 1b: 翻转既有 k4 测试的"同原型出生一致"断言**

在 `src/test/integration/workforce-persona-bootstrap-k4.test.ts` 里，找到第 73-74 行：

```ts
    /* 同原型 → 出生风格相同（模板一致），但是写入两行独立。 */
    assert.deepEqual(a.decisionStyle.get(), b.decisionStyle.get(), '同原型出生风格一致');
```

改为（同原型不同 personaId 现在**出生即被扰动拉开**，至少一维不同）：

```ts
    /* 同原型不同 personaId → 出生即被 per-persona 扰动拉开（PR：出生多样性），至少一维不同。 */
    assert.notDeepEqual(a.decisionStyle.get(), b.decisionStyle.get(), '同原型不同 personaId 出生应被扰动拉开');
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```bash
npm run build >/tmp/b.log 2>&1; echo "build exit=$?"; grep -iE "error TS" /tmp/b.log | head
node --test --test-force-exit dist/test/integration/persona-birth-perturbation.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: FAIL —— 出生未扰动，8 个同原型 persona 决策风格全同 → `diversityScore===0` → 第一个测试失败。
（此时 k4 测试的翻转断言 1b 也会失败，因实现还没改——正常，Step 4 一起转绿。）

- [ ] **Step 3: 改 workforce 实现**

3a. 第 21 行 import 追加 `perturbDecisionStyle`：

```ts
import { archetypeDecisionStyle, perturbDecisionStyle, type PersonalityArchetype } from '@chrono/kernel';
```

3b. 在 import 之后、`WorkerPersonaSpec` 接口之前（约第 22 行）加本地常量：

```ts
/** 出生扰动幅度（同原型内个体差异）。与多租户路径 tenant-os-factory 的 DEFAULT_PERSONALITY_BIRTH_MAGNITUDE
 * 同值 0.15；该常量未从 kernel 导出，此处本地定义（镜像 tenant-factory 模式，不扩 kernel API）。 */
const BIRTH_MAGNITUDE = 0.15;
```

3c. 第 114 行出生写入：

```ts
    /* 出生：写原型决策风格 + 一句出生叙事（确定性）。 */
    core.decisionStyle.set(archetypeDecisionStyle(spec.archetype, this.now()));
```

改为（原型基准 → per-persona 扰动 → 写）：

```ts
    /* 出生：原型基准决策风格 + per-persona 扰动（seed=personaId，同原型个体也不同）→ 写 + 一句出生叙事（确定性）。 */
    const baseStyle = archetypeDecisionStyle(spec.archetype, this.now());
    core.decisionStyle.set(perturbDecisionStyle(baseStyle, spec.personaId, BIRTH_MAGNITUDE, this.now()));
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
npm run build >/tmp/b.log 2>&1; echo "build exit=$?"; grep -iE "error TS" /tmp/b.log | head
node --test --test-force-exit \
  dist/test/integration/persona-birth-perturbation.test.js \
  dist/test/integration/workforce-persona-bootstrap-k4.test.js \
  2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: build exit=0；两个文件全 PASS（新测 diversityScore>0 + 可复现；k4 翻转后的断言与其余 k4 用例全绿——尤其 `4 原型两两不同` 仍 distinct==4，因跨原型基准差异远大于扰动）。

- [ ] **Step 5: workforce/bootstrap 全面回归 + 守卫不破**

Run:
```bash
node --test --test-force-exit \
  dist/test/integration/workforce-persona-bootstrap-k4.test.js \
  dist/test/integration/seed-org-k6.test.js \
  2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: 全绿（尤其"已出生 persona 再 bootstrap → skipped_existing"守卫不破；seed-org 幂等出生不受扰动影响）。

- [ ] **Step 6: 提交**

```bash
git add src/workforce/workforce-persona-bootstrap-service.ts \
        src/test/integration/persona-birth-perturbation.test.ts \
        src/test/integration/workforce-persona-bootstrap-k4.test.ts
git commit -m "$(printf 'feat(workforce): birthPersona 加 per-persona 出生扰动（seed=personaId）\n\n消除主缺陷：同原型 persona 出生逐字节相同（全库最多 4 种）。出生态\n从纯原型 → 原型+personaId 扰动（幅度 0.15），同原型个体也不同。\nisPristine 守卫不变，已成长人格不覆盖；同 personaId 可复现。\n翻转 k4 测试第 74 行断言（同原型两实例现在故意不同）。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: 全量验证 + 收尾

**Files:** 无新增（仅验证）

- [ ] **Step 1: typecheck 全量**

Run: `npm run typecheck`
Expected: exit 0，无错误。

- [ ] **Step 2: 全量构建 + kernel 强制重建确认一致**

Run:
```bash
npx tsc -b packages/kernel --force >/dev/null 2>&1 && npm run build >/tmp/b.log 2>&1; echo "build exit=$?"; grep -iE "error TS" /tmp/b.log | head
```
Expected: exit 0，无编译错误。

- [ ] **Step 3: 本特性 + 相邻全绿**

Run:
```bash
node --test --test-force-exit \
  packages/kernel/dist-test/test/decision-style-perturbation.test.js \
  packages/kernel/dist-test/test/personality-diversity.test.js \
  packages/kernel/dist-test/test/personality-archetypes.test.js \
  dist/test/unit/persona-birth-perturbation.test.js \
  2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: 全绿，fail 0。

- [ ] **Step 4: 全量 unit 回归（确认零回归）**

Run: `node --test --test-force-exit 'dist/test/unit/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: fail 0（`personalityDiversity`/出生扰动改动不应波及无关测试）。

- [ ] **Step 5: 无新增文件需提交则跳过；否则提交验证产物**（本 Task 通常无改动，仅确认全绿，无需提交）

---

## Self-Review

**1. Spec coverage:**
- 改动 1（birthPersona per-persona 扰动，seed=personaId，本地 BIRTH_MAGNITUDE）→ Task 2。✓
- 改动 2（hashSeed 32→64 位 BigInt）→ Task 1 Step 3c。✓
- 改动 3（deliberationDepth INT_DIM_SCALE=10）→ Task 1 Step 3a/3b。✓
- 不变量 1/2/3/4（拉开/可复现/分叉/守卫）→ Task 2 测试 + Step 5 守卫回归。✓（分叉由 diversityScore>0 蕴含）
- 不变量 5/6/7（64 位确定性/magnitude=0 零回归/deliberationDepth 拉开）→ Task 1 测试（既有"magnitude=0 不扰动"+"结果合法"+新增两测）。✓
- 「须重建 kernel dist」→ Task 1 Step 2/4、Task 3 Step 2 均显式 `tsc -b packages/kernel --force`。✓
- YAGNI（不加 spec 字段/不动 tenantId 语义/不提升常量进 kernel）→ 三 Task 均未触及。✓

**2. Placeholder scan:** 无 TBD/TODO；每个代码步给完整代码；命令给 expected。✓

**3. Type consistency:** `perturbDecisionStyle(base, seed, magnitude, now)` 签名在 Task 1 不变、Task 2 一致调用；`INT_DIM_SCALE`/`BIRTH_MAGNITUDE` 常量名前后一致；`personalityDiversity(styles).diversityScore` 字段名与既有 kernel 定义一致。✓

**已验证（写计划时对齐真实 API）:**
- 构造链已核对 `workforce-persona-bootstrap-k4.test.ts` 的真实 setup：`OrgWorkforceStore(db, tenant)` +
  `OrgChartService(store, ()=>clock.now(), idgen)` + `WorkforcePersonaBootstrapService(os, chart, ()=>clock.now())`；
  `WorkerSpec` 真实字段 = `{roleCode, title, jobFamily, seniority, displayName, personaId, managerRoleCode, [archetype]}`
  （Task 2 测试已按此写，无需再对齐）。
- `perturbDecisionStyle` 已确认从 `@chrono/kernel` 导出（`packages/kernel/src/domain/core-self/index.ts:15` →
  root `index.ts:47`），与既有 `archetypeDecisionStyle` 同一 barrel。

**注意点（实现者留意）:**
- 行号以「就近锚点」为准（`archetypeDecisionStyle(spec.archetype, this.now())` 出生写入行、`hashSeed` 函数体、
  `DELIBERATION_MIN` 常量行、k4 测试的 `'同原型出生风格一致'` 断言行），漂移时按锚点定位。
