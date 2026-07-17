# 编译锁去全局化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把蒸馏编译锁从租户级全局（`GLOBAL_LEASE_PERSONA_ID`）收窄到 per-persona（真实 `personaId`），让同租户不同 persona 的编译从全串行变并行；正式编译 + 影子验收两处一起改；不改 schema。

**Architecture:** 先落「跨 persona 隔离安全网」测试证明底层 store 隔离真成立（前置），再收窄两处锁 key，最后更新两个前提已过时（per-persona 快照后不再成立）的既有锁测试断言 + 同步陈旧注释。TDD、每 Task 独立可测。

**Tech Stack:** TypeScript (ESM, `.js` 后缀)，`node:test` + `node:assert/strict`，内存 SQLite（`createMemoryDatabase`/OS `getDatabase()`），`PersonaLeaseStore`（真 CAS lease）、`DistillationService`、`ShadowExamVerifier`。

## Global Constraints

- 注释/文档简体中文（意图/约束/用法）。
- 三处均在 `isPristine`/per-persona 隔离前提内，**不改变已落库人格**；可复现不破。
- 锁 key：`GLOBAL_LEASE_PERSONA_ID` → 真实 `personaId`（`acquire(personaId, 'compile', now, ttl)` 首参）。
- 无 schema 变更（lease 表 `v081` 已 `(tenant_id, persona_id, purpose)`）。
- TTL 不变（两处 60_000ms）。
- 未注入 leaseStore → 单进程同步语义零回归。
- **安全根基:** 编译临界区触碰的全 7 维内核 + 快照/回滚均 per-persona（`chrono-synth-os.ts:545,595,611-615` 证实 `createSnapshot(personaId)` + `coreSelfOnly` 回滚只动该 persona）。安全网测试（Task 1）先于收窄锁（Task 2/3）。
- **测试演进纪律（非 grader-gaming）:** 翻转的既有断言，其**前提已因 per-persona 快照客观失效**；每处翻转须带注释说明旧前提为何不再成立 + 引用 per-persona 快照代码。禁止「为让红变绿而改断言」——只有前提确证过时才改。
- 本地验证强制，失败即止。

---

### Task 1: 【安全网·前置】跨 persona 编译隔离测试（value_shift + memory_edge）

**Files:**
- Test: `src/test/unit/compile-cross-persona-isolation.test.ts`（新建）

**Interfaces:**
- Consumes: `DistillationService`（`src/intelligence/distillation-service.js`）、`DistilledArtifactStore`、`ArtifactCompiler`、`PersonaLeaseStore`、`ChronoSynthOS`。
- Produces: 证明底层 `core_values` / `memory_edges` 按 persona 隔离——是 Task 2 收窄锁安全的前提证据。

- [ ] **Step 1: 写测试（此刻应已 PASS——证明隔离现状，不是待实现功能）**

创建 `src/test/unit/compile-cross-persona-isolation.test.ts`：

```ts
/**
 * 安全网（缺口 #4 前置）：同租户两 persona 各编译 value_shift + memory_edge，落各自 core，互不污染。
 * 这是「收窄编译锁到 per-persona 安全」的前提证据——底层 store 隔离真成立才敢放并行。
 * 用真 ChronoSynthOS（真 CoreRhythmLayer + 真 executor），不 mock 编译目标。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

describe('编译跨 persona 隔离（#4 安全网）', () => {
  it('value_shift：两 persona 各改各的价值权重，互不串', () => {
    const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    const a = os.getCore('p-A');
    const b = os.getCore('p-B');
    const va = a.addValue('诚信', 0.5);
    const vb = b.addValue('诚信', 0.5);
    /* 模拟编译 value_shift：各自改各自 persona 的价值权重。 */
    a.updateValueParams(va.id, { weight: 0.9 });
    b.updateValueParams(vb.id, { weight: 0.1 });
    assert.equal([...a.values.getAll().values()].find((v) => v.id === va.id)?.weight, 0.9);
    assert.equal([...b.values.getAll().values()].find((v) => v.id === vb.id)?.weight, 0.1);
    /* A 的价值在 B 的 core 里不可见（隔离）。 */
    assert.equal([...b.values.getAll().values()].some((v) => v.id === va.id), false);
    os.close();
  });

  it('memory_edge：两 persona 各建各的记忆边，落 memory_edges 各自 persona_id，互不串', () => {
    const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger(), tenantId: 't1' });
    os.start();
    const a = os.getCore('p-A');
    const b = os.getCore('p-B');
    const a1 = a.addMemory('semantic', 'A 的记忆1', 0, 0.7);
    const a2 = a.addMemory('semantic', 'A 的记忆2', 0, 0.7);
    const b1 = b.addMemory('semantic', 'B 的记忆1', 0, 0.7);
    const b2 = b.addMemory('semantic', 'B 的记忆2', 0, 0.7);
    a.linkMemories(a1.id, a2.id, 'relates', 0.8);
    b.linkMemories(b1.id, b2.id, 'relates', 0.8);
    /* A 的边只在 A 的 core 可见，B 的边只在 B 可见（persona_id 隔离）。 */
    assert.equal(a.memories.getAllEdges().length, 1);
    assert.equal(b.memories.getAllEdges().length, 1);
    assert.equal(a.memories.getAllEdges()[0]?.source, a1.id);
    assert.equal(b.memories.getAllEdges()[0]?.source, b1.id);
    os.close();
  });
});
```

- [ ] **Step 2: 跑测试确认 PASS（证明隔离现状成立）**

Run: `npm run build >/dev/null 2>&1 && node --test --test-force-exit dist/test/unit/compile-cross-persona-isolation.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: 2 tests PASS。**若任一 FAIL** → 底层 store 未真隔离，spec 安全论证有误，**立即停止**（不得继续收窄锁），把失败详情记入 operations-log 并回退到 brainstorm。

- [ ] **Step 3: 提交**

```bash
git add src/test/unit/compile-cross-persona-isolation.test.ts
git commit -m "$(printf 'test(core): 编译跨 persona 隔离安全网（#4 前置）\n\n证明 value_shift/memory_edge 编译落各自 persona core，互不污染——\n收窄编译锁到 per-persona 的前提证据。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: 正式编译锁收窄到 per-persona

**Files:**
- Modify: `src/intelligence/distillation-service.ts`（第 293-298 行 acquire + 相邻注释）
- Test: `src/test/unit/compile-lease-per-persona.test.ts`（新建）

**Interfaces:**
- Consumes: `DistillationService.approve(personaId, artifactId)` 触发编译；`PersonaLeaseStore.acquire(personaId, 'compile', now, ttl)`。
- Produces: 同 persona 编译互斥；不同 persona 并行（不再互相 `lease_busy`）。

- [ ] **Step 1: 写失败测试**

创建 `src/test/unit/compile-lease-per-persona.test.ts`：

```ts
/**
 * #4：编译锁收窄到 per-persona。同 persona 互斥、跨 persona 并行（收益证明）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { DistillationService } from '../../intelligence/distillation-service.js';
import { DistilledArtifactStore } from '../../storage/distilled-artifact-store.js';
import { PersonaLeaseStore } from '../../storage/persona-lease-store.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock } from '../../utils/clock.js';
import { SilentLogger } from '../../utils/logger.js';
import type { ArtifactCompiler } from '../../intelligence/artifact-compiler.js';
import type { SnapshotGuard } from '../../intelligence/distillation-service.js';
import type { CompileOutcome } from '../../intelligence/artifact-compiler.js';
import type { IDatabase } from '../../storage/database.js';

const TENANT = 't1';
function candidate(id: string) {
  return {
    id, kind: 'value_shift' as const, source: 'reflection' as const,
    payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
    confidence: 0.9,
    evidence: [{ type: 'pattern' as const, id: 'e1', score: 0.8 }, { type: 'memory' as const, id: 'm1', score: 0.6 }],
    status: 'candidate' as const, createdAt: 1000,
  };
}
function mkSvc(db: IDatabase, leases: PersonaLeaseStore) {
  const store = new DistilledArtifactStore(db, TENANT);
  const guard: SnapshotGuard = { snapshot: () => 'snap', rollback: () => true };
  const compiler = { compile: (): CompileOutcome => ({ ok: true, applied: 'x' }) } as unknown as ArtifactCompiler;
  const svc = new DistillationService({
    store, compiler, snapshotGuard: guard,
    bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
    tenantId: TENANT, leaseStore: leases,
  });
  return { store, svc };
}

describe('#4 编译锁 per-persona', () => {
  it('跨 persona 不再互相 busy：B 持自己的锁时，A 仍能编译（收益证明）', () => {
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);
    const leases = new PersonaLeaseStore(db, TENANT);
    const { store, svc } = mkSvc(db, leases);
    store.insert('persona_A', candidate('dart-A'));
    /* B 占住**自己 persona 的** compile 锁（per-persona key）。 */
    const heldByB = leases.acquire('persona_B', 'compile', 1000, 60_000);
    assert.ok(heldByB);
    /* A 的 approve 不应被 B 的锁挡住——收窄后跨 persona 并行。 */
    const r = svc.approve('persona_A', 'dart-A');
    assert.equal(r.ok, true, 'A 应能编译（不被 B 的 per-persona 锁阻挡）');
    assert.equal(store.getById('persona_A', 'dart-A')?.status, 'compiled');
  });

  it('同 persona 互斥：A 持锁时，A 的另一次 approve 被挡（lease_busy）', () => {
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);
    const leases = new PersonaLeaseStore(db, TENANT);
    const { store, svc } = mkSvc(db, leases);
    store.insert('persona_A', candidate('dart-A'));
    /* A 自己的 compile 锁被占（模拟同 persona 另一编译进行中）。 */
    const heldByA = leases.acquire('persona_A', 'compile', 1000, 60_000);
    assert.ok(heldByA);
    const r = svc.approve('persona_A', 'dart-A');
    assert.equal(r.ok, false, '同 persona 编译应互斥');
    assert.equal(store.getById('persona_A', 'dart-A')?.status, 'approved');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build >/dev/null 2>&1 && node --test --test-force-exit dist/test/unit/compile-lease-per-persona.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: FAIL —— 第一个测试（跨 persona 不互斥）失败：现状全局锁下，B 占 `persona_B` key 不影响 A（因当前 A 抢的是 `__global__`），但 A 的 approve 抢 `__global__`... 实际当前实现下 B 占 `persona_B` **不挡** A 的 `__global__` → 第一测试可能已 PASS；真正驱动改动的是**同 persona 互斥**测试在现状下会失败（A 占 `persona_A`，但 approve 抢 `__global__`，两把不同锁 → 不互斥 → 第二测试 FAIL）。以实际 FAIL 为准（第二测试必 FAIL）。

- [ ] **Step 3: 收窄正式编译锁**

`src/intelligence/distillation-service.ts:293-298`，把：

```ts
    const handle: LeaseHandle | null = this.deps.leaseStore.acquire(
      GLOBAL_LEASE_PERSONA_ID, 'compile', this.deps.clock.now(), COMPILE_LEASE_TTL_MS,
    );
    if (!handle) {
      this.deps.logger.warn(LAYER, `编译延后：全局 compile 锁被占用，另一编译进行中（persona=${personaId}）`);
      return 'lease_busy';
    }
```

改为（key 从全局 sentinel 换成真实 personaId）：

```ts
    const handle: LeaseHandle | null = this.deps.leaseStore.acquire(
      personaId, 'compile', this.deps.clock.now(), COMPILE_LEASE_TTL_MS,
    );
    if (!handle) {
      this.deps.logger.warn(LAYER, `编译延后：persona=${personaId} 的 compile 锁被占用（同 persona 另一编译/影子进行中）`);
      return 'lease_busy';
    }
```

同步更新第 278-284 行方法注释：把「租户级全局 compile mutex」「用 GLOBAL_LEASE_PERSONA_ID 让全租户编译竞争同一把锁」改为反映 per-persona 现状（K5b 后编译写集 + 快照/回滚均 per-persona，故锁收窄到 personaId：同 persona 互斥、跨 persona 并行）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build >/dev/null 2>&1 && node --test --test-force-exit dist/test/unit/compile-lease-per-persona.test.js 2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"`
Expected: 2 tests PASS。

- [ ] **Step 5: 提交**

```bash
git add src/intelligence/distillation-service.ts src/test/unit/compile-lease-per-persona.test.ts
git commit -m "$(printf 'feat(core): 正式编译锁收窄到 per-persona（#4）\n\nGLOBAL_LEASE_PERSONA_ID→personaId。同 persona 编译互斥、跨 persona 并行。\nK5b 后编译写集+快照/回滚均 per-persona，全局锁理由已失效。同步陈旧注释。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: 影子验收编译锁收窄 + 更新两个前提过时的既有测试

**Files:**
- Modify: `src/intelligence/shadow-exam-verifier.ts`（第 97-98 行 acquire + 注释）
- Modify: `src/test/integration/persona-lease-enforcement.test.ts`（第 108 行起「跨 persona 全局互斥」用例——前提已过时）
- Modify: `src/test/integration/shadow-exam-verifier-l4.test.ts`（第 159 行起 `'__global__'` 锁用例——前提已过时）

**Interfaces:**
- Consumes: `ShadowExamVerifier.verify(personaId, examSpec, candidate)`；`acquire(personaId, 'compile', ...)`。
- Produces: 同 persona 影子编译与正式编译互斥；不同 persona 不互斥。红线13 在 per-persona 层面成立。

- [ ] **Step 1: 收窄影子验收锁**

`src/intelligence/shadow-exam-verifier.ts:97-98`，把：

```ts
    /* ③ compile lease（红线 13）：影子编译期间持租户级 compile 锁，与正式编译/另一影子互斥。 */
    const lease = this.leaseStore?.acquire(GLOBAL_LEASE_PERSONA_ID, 'compile', this.now(), SHADOW_COMPILE_LEASE_TTL_MS);
```

改为：

```ts
    /* ③ compile lease（红线 13）：影子编译期间持**该 persona 的** compile 锁——与**同 persona** 的正式编译/
     *    另一影子互斥（抢同一把 (tenant, personaId, 'compile')）；不同 persona 无需互斥（影子核独立 EventBus +
     *    per-persona 快照，K5b）。 */
    const lease = this.leaseStore?.acquire(personaId, 'compile', this.now(), SHADOW_COMPILE_LEASE_TTL_MS);
```

- [ ] **Step 2: 更新 `persona-lease-enforcement.test.ts` 的过时用例**

该文件第 108 行起的用例断言「persona B 占全局锁 → persona A 被挡」，注释称「防 A/B 并发覆盖 system-global 快照」。**此前提已客观失效**：`chrono-synth-os.ts:545,595,611-615` 证实快照是 `createSnapshot(personaId)`、回滚 `coreSelfOnly` 只动该 persona，system-global 快照覆盖场景不存在。将该用例改为验证 per-persona 语义：

把原用例（`it('跨 persona 全局互斥：persona B 占住全局 compile 锁 → persona A 的 approve 被挡...`）整体替换为：

```ts
  it('跨 persona 不互斥（#4：per-persona 锁）：persona B 占自己的 compile 锁 → persona A 仍能编译', () => {
    /* 前提演进：ADR-0056 K5 后快照/回滚已 per-persona（createSnapshot(personaId) + coreSelfOnly，
     * 见 chrono-synth-os.ts:545,595,611-615），原「A/B 覆盖 system-global 快照」的风险不存在，
     * 故锁收窄到 per-persona——跨 persona 编译并行。 */
    const store = new DistilledArtifactStore(db, TENANT);
    const personaA = 'persona_A';
    store.insert(personaA, {
      id: 'dart-A', kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
      status: 'candidate', createdAt: 1000,
    });
    let snapshotTaken = false;
    const guard: SnapshotGuard = { snapshot: () => { snapshotTaken = true; return 'snap'; }, rollback: () => true };
    const compiler = { compile: (): CompileOutcome => ({ ok: true, applied: 'x' }) } as unknown as ArtifactCompiler;
    const svc = new DistillationService({
      store, compiler, snapshotGuard: guard,
      bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
      tenantId: TENANT, leaseStore: leases,
    });
    /* persona B 占住**自己的** compile 锁（per-persona key）。 */
    const heldByB = leases.acquire('persona_B', 'compile', 1000, 60_000);
    assert.ok(heldByB);
    /* persona A 的 approve 不被 B 的锁挡——跨 persona 并行。 */
    const r = svc.approve(personaA, 'dart-A');
    assert.equal(r.ok, true, 'A 应能编译（跨 persona 不互斥）');
    assert.equal(snapshotTaken, true, 'A 正常快照并编译');
    assert.equal(store.getById(personaA, 'dart-A')?.status, 'compiled');
  });

  it('同 persona 互斥：persona A 占自己的 compile 锁 → A 的另一次 approve 被挡', () => {
    const store = new DistilledArtifactStore(db, TENANT);
    const personaA = 'persona_A';
    store.insert(personaA, {
      id: 'dart-A2', kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
      status: 'candidate', createdAt: 1000,
    });
    let snapshotTaken = false;
    const guard: SnapshotGuard = { snapshot: () => { snapshotTaken = true; return 'snap'; }, rollback: () => true };
    const compiler = { compile: (): CompileOutcome => ({ ok: true, applied: 'x' }) } as unknown as ArtifactCompiler;
    const svc = new DistillationService({
      store, compiler, snapshotGuard: guard,
      bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
      tenantId: TENANT, leaseStore: leases,
    });
    const heldByA = leases.acquire(personaA, 'compile', 1000, 60_000);
    assert.ok(heldByA);
    const r = svc.approve(personaA, 'dart-A2');
    assert.equal(r.ok, false);
    assert.equal(snapshotTaken, false, '同 persona 锁被占时不快照');
    assert.equal(store.getById(personaA, 'dart-A2')?.status, 'approved');
  });
```

（若该文件顶部还 import 了 `GLOBAL_LEASE_PERSONA_ID` 且不再被其它用例使用，删除该 import 避免 unused 编译错误。）

- [ ] **Step 3: 更新 `shadow-exam-verifier-l4.test.ts` 的过时用例**

第 159 行起的用例先占 `'__global__'` 锁，再断言另一 persona 的 verify 被挡。收窄后应改为**同 persona** 占锁才挡。把占锁行与断言改为：

原（占全局锁 → 挡 `p-researcher`）：

```ts
    /* 先占住全局 compile 锁。 */
    const held = leaseStore.acquire('__global__', 'compile', clock.now(), 60_000);
    assert.ok(held, '先占锁成功');
    const r = v.verify('p-researcher', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));
    assert.equal(r.ok, false);
```

改为（占 **同 persona** `p-researcher` 的锁 → 挡同 persona verify）：

```ts
    /* #4：锁 per-persona——占住**同 persona** 的 compile 锁才互斥。 */
    const held = leaseStore.acquire('p-researcher', 'compile', clock.now(), 60_000);
    assert.ok(held, '先占同 persona 锁成功');
    const r = v.verify('p-researcher', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));
    assert.equal(r.ok, false);
```

在该用例的 `leaseStore.release(held!)` + 「释放后可正常验收」之后，追加一条**跨 persona 不互斥**断言（证明收益，另一 persona 占锁不挡）：

```ts
    /* #4 收益：另一 persona 占锁不挡本 persona 验收（跨 persona 并行）。 */
    const heldOther = leaseStore.acquire('p-other', 'compile', clock.now(), 60_000);
    assert.ok(heldOther, '占另一 persona 锁');
    const r3 = v.verify('p-researcher', researchExam(), narrativeCandidate('我擅长文献检索、综合归纳、引用来源。'));
    assert.equal(r3.ok, true, '另一 persona 占锁不挡本 persona');
    leaseStore.release(heldOther!);
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
npm run build >/dev/null 2>&1 && node --test --test-force-exit \
  dist/test/integration/persona-lease-enforcement.test.js \
  dist/test/integration/shadow-exam-verifier-l4.test.js \
  2>&1 | grep -E "tests [0-9]|pass [0-9]|fail [0-9]"
```
Expected: 两文件全 PASS（更新后的 per-persona 断言 + 其余既有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/intelligence/shadow-exam-verifier.ts src/test/integration/persona-lease-enforcement.test.ts src/test/integration/shadow-exam-verifier-l4.test.ts
git commit -m "$(printf 'feat(core): 影子验收编译锁收窄 per-persona + 更新过时锁测试（#4）\n\n影子验收 acquire 改传 personaId（红线13 在 per-persona 层成立）。\n更新两处既有测试：其「全局互斥防 system-global 快照覆盖」前提已因\nper-persona 快照（K5 coreSelfOnly）客观失效，改验同 persona 互斥+跨 persona 并行。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: 同步陈旧注释 + 全量验证

**Files:**
- Modify: `src/intelligence/artifact-compiler.ts:79-82`（「executor 未扩」已过时）
- Modify: `packages/kernel/src/domain/persona/persona-lease-types.ts`（全局锁说明）

- [ ] **Step 1: 更新 artifact-compiler 陈旧注释**

`src/intelligence/artifact-compiler.ts:79-82` 的「value_shift / memory_edge → ... 仍是 tenant 键（persona_id 列已加但 executor 未扩，K5b 后续子片）...尚未 persona 隔离」整段，改为反映 K5b 现状：

```ts
   *   - value_shift / memory_edge → ValueStore（core_values）/ CognitiveMemoryGraph（memory_edges）在
   *     CoreRhythmLayer 内**已按 persona_id 隔离**（ADR-0056 K5b：executor 已扩，见 value-executors.ts /
   *     memory-executors.ts 的 WHERE persona_id）。不同 persona 各自落各自的行，互不串脑。
```

- [ ] **Step 2: 更新 persona-lease-types.ts 全局锁说明（如仍描述 compile 必须全局）**

若 `packages/kernel/src/domain/persona/persona-lease-types.ts:8,30,37` 附近注释仍称 compile 必须用 `GLOBAL_LEASE_PERSONA_ID` 做租户级全局互斥「否则全局 restoreFromSnapshot 回滚会被并发写者覆盖」，补一句现状说明（不删常量，仅澄清 compile 已改 per-persona）：

```ts
 *   注（2026-07：ADR-0056 K5 后）：compile 锁已收窄到 per-persona（distillation/shadow-exam 传 personaId），
 *   因快照/回滚已 per-persona（createSnapshot(personaId) + coreSelfOnly）。GLOBAL_LEASE_PERSONA_ID 常量保留
 *   备用，compile 路径不再使用它。
```

（若这些行的具体措辞不同，按「就近锚点」定位后等价改写；核心是消除「compile 必须全局」的过时陈述。改 kernel 后须 `tsc -b packages/kernel --force`。）

- [ ] **Step 3: typecheck + kernel 重建 + 全量回归**

Run:
```bash
npx tsc -b packages/kernel --force >/dev/null 2>&1 && npm run typecheck 2>&1 | tail -2; echo "tc exit=$?"
npm run build >/tmp/b.log 2>&1; echo "build exit=$?"; grep -iE "error TS" /tmp/b.log | head
node --test --test-force-exit \
  dist/test/unit/compile-cross-persona-isolation.test.js \
  dist/test/unit/compile-lease-per-persona.test.js \
  dist/test/integration/persona-lease-enforcement.test.js \
  dist/test/integration/shadow-exam-verifier-l4.test.js \
  dist/test/unit/distillation-service-compensation.test.js \
  2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: typecheck exit 0；build exit 0；本特性 + 相邻蒸馏/影子测试全绿。

- [ ] **Step 4: 全量 unit 回归（零回归确认）**

Run: `node --test --test-force-exit 'dist/test/unit/**/*.test.js' 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: fail 0。

- [ ] **Step 5: 提交**

```bash
git add src/intelligence/artifact-compiler.ts packages/kernel/src/domain/persona/persona-lease-types.ts
git commit -m "$(printf 'docs(core): 同步陈旧注释——compile 锁 per-persona + K5b executor 已扩\n\nartifact-compiler「executor 未扩」+ persona-lease-types「compile 必须全局」\n均为 K5b/K5 前的过时陈述，改为反映 per-persona 现状。\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review

**1. Spec coverage:**
- spec 改动 1（正式编译锁收窄）→ Task 2。✓
- spec 改动 2（影子验收锁收窄）→ Task 3 Step 1。✓
- spec 不变量 1（跨 persona 隔离安全网 value+memory）→ Task 1。✓
- spec 不变量 1b（memory_edges 冲突键边界）→ **注：Task 1 覆盖了「隔离成立」正面；冲突键弱守卫的负面边界（两 persona 同 (source,target)）spec 列为「实施时评估」非强制前置。** 已在 Task 1 用不同 memory id 验证正常路径隔离；冲突键极端边界不阻断本次锁收窄（memory id 全局随机），留作实施观察项——若要强制覆盖需额外一步，当前按 spec「实施时评估」处理，不加 task。
- spec 不变量 2（同 persona 互斥）→ Task 2 + Task 3。✓
- spec 不变量 3（跨 persona 不 busy 收益）→ Task 2 + Task 3。✓
- spec 不变量 4（单进程零回归）→ 未新增独立 task；由「未注入 leaseStore 走 compileApprovedLocked」现状保证，Task 4 全量回归覆盖既有单进程测试。✓
- spec 不变量 5（快照/回滚 per-persona）→ Task 3 更新用例的 `snapshotTaken` 断言 + 既有 compensation 测试回归（Task 4）。✓
- spec 不变量 6（预算复核正确）→ 现状 `unverifiedGrowthBudgetExceeded(personaId)` 已 per-persona，收窄锁不改；全量回归覆盖。✓
- spec 本地验证·文档注释同步 → Task 4。✓
- spec 既有债（动态预算 default core）→ 明确不做，无 task。✓

**2. Placeholder scan:** 无 TBD/TODO；每个代码步给完整代码；命令给 expected。✓

**3. Type consistency:** `acquire(personaId, 'compile', now, ttl)` 签名在 Task 2/3 一致；`approve(personaId, artifactId)`、`verify(personaId, examSpec, candidate)`、`SnapshotGuard`/`CompileOutcome`/`ArtifactCompiler` 类型名与源码一致；`GLOBAL_LEASE_PERSONA_ID` 停用后 import 清理已提示（Task 3 Step 2 末）。✓

**注意点（实现者留意）:**
- Task 2 Step 2 的「预期失败」以**同 persona 互斥测试必 FAIL** 为准（现状 approve 抢 `__global__`、测试占 `persona_A`，两锁不互斥）；跨 persona 测试在现状下可能已 PASS，不作为 red 依据。
- 行号以就近锚点为准（`acquire(GLOBAL_LEASE_PERSONA_ID, 'compile'` 两处、测试里 `'__global__'`/`GLOBAL_LEASE_PERSONA_ID` 字面量、`artifact-compiler.ts` 的「executor 未扩」注释）。
- 翻转既有断言前，先确认 Task 1 安全网 PASS（隔离成立）——这是「前提确已过时」的证据，不是为凑绿改断言。
