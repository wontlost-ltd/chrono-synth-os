/**
 * K2（ADR-0056）每-(租户, 人格) 认知内核隔离·人格特征三表 persona 化端到端。
 *
 * 验证 decision_style / cognitive_model / narrative 经 **service + executor + 复合主键** 真正按
 * (tenant, persona) 隔离——同租户两个 persona 各有独立的决策风格/认知模型/自我叙事，互不覆盖；
 * 旧调用（不传 personaId）仍命中 default 人格（向后兼容）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { registerCoreSelfExecutors } from '../../storage/executors/index.js';
import type { IDatabase } from '../../storage/database.js';
import { DecisionStyleStore } from '../../core/decision-style-store.js';
import { NarrativeStore } from '../../core/narrative-store.js';
import { CognitiveModelStore } from '../../core/cognitive-model-store.js';
import { TestClock } from '../../utils/clock.js';

describe('K2 ADR-0056 人格特征三表 per-(tenant, persona) 隔离', () => {
  let db: IDatabase;
  const clock = new TestClock(1000);
  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    registerCoreSelfExecutors();
  });

  it('★decision_style 按 persona 隔离★：同租户 explorer vs guardian 各自独立风格，不覆盖', () => {
    const explorer = new DecisionStyleStore(db, clock, 't1', 'explorer-01');
    const guardian = new DecisionStyleStore(db, clock, 't1', 'guardian-01');
    explorer.set({ riskAppetite: 0.9, explorationBias: 0.9 });
    guardian.set({ riskAppetite: 0.1, explorationBias: 0.1, lossAversion: 3 });
    /* 各自读回各自的——不串。 */
    assert.equal(explorer.get().riskAppetite, 0.9);
    assert.equal(guardian.get().riskAppetite, 0.1);
    assert.equal(guardian.get().lossAversion, 3);
    /* 写 explorer 不影响 guardian。 */
    explorer.set({ riskAppetite: 0.7 });
    assert.equal(explorer.get().riskAppetite, 0.7);
    assert.equal(guardian.get().riskAppetite, 0.1, 'guardian 未被 explorer 覆盖');
  });

  it('★narrative 按 persona 隔离★：两 persona 各自的自我叙事独立', () => {
    const a = new NarrativeStore(db, clock, 't1', 'p-a');
    const b = new NarrativeStore(db, clock, 't1', 'p-b');
    a.set('我是大胆的探索者');
    b.set('我是谨慎的守护者');
    assert.equal(a.get(), '我是大胆的探索者');
    assert.equal(b.get(), '我是谨慎的守护者');
  });

  it('★cognitive_model 按 persona 隔离★：两 persona 各自认知模型独立', () => {
    const a = new CognitiveModelStore(db, clock, 't1', 'p-a');
    const b = new CognitiveModelStore(db, clock, 't1', 'p-b');
    a.set({ growthMindset: 0.9 });
    b.set({ growthMindset: 0.2 });
    assert.equal(a.get().growthMindset, 0.9);
    assert.equal(b.get().growthMindset, 0.2);
    assert.ok(a.exists());
    assert.ok(b.exists());
  });

  it('★向后兼容★：不传 personaId → default 人格（legacy companion/manager 路径不变）', () => {
    const legacy = new DecisionStyleStore(db, clock, 't1'); /* personaId 缺省 default */
    legacy.set({ riskAppetite: 0.93 }); /* 非默认值，便于区分 */
    /* 显式 default persona 读到同一行（legacy 写入 = default persona）。 */
    const explicitDefault = new DecisionStyleStore(db, clock, 't1', 'default');
    assert.equal(explicitDefault.get().riskAppetite, 0.93, 'legacy 写入 = default persona');
    /* 另一 persona 看不到 legacy 写的（未写 → 返回默认，updatedAt=0）。 */
    const other = new DecisionStyleStore(db, clock, 't1', 'other');
    assert.equal(other.get().updatedAt, 0, 'other persona 未写过 → 默认态');
    assert.notEqual(other.get().riskAppetite, 0.93, 'other persona 不串 legacy 的写入');
  });

  it('★租户隔离仍在★：不同租户同 persona id 互不可见', () => {
    new DecisionStyleStore(db, clock, 't1', 'p').set({ riskAppetite: 0.9 });
    new DecisionStyleStore(db, clock, 't2', 'p').set({ riskAppetite: 0.1 });
    assert.equal(new DecisionStyleStore(db, clock, 't1', 'p').get().riskAppetite, 0.9);
    assert.equal(new DecisionStyleStore(db, clock, 't2', 'p').get().riskAppetite, 0.1);
  });

  it('★主键已复合★：三张人格特征表主键 = (tenant_id, persona_id)', () => {
    for (const t of ['decision_style', 'cognitive_model', 'narrative']) {
      const pk = db.prepare<{ name: string; pk: number }>(`PRAGMA table_info(${t})`).all()
        .filter((c) => c.pk > 0).map((c) => c.name).sort();
      assert.deepEqual(pk, ['persona_id', 'tenant_id'], `${t} 主键应为 (tenant_id, persona_id)`);
    }
  });
});
