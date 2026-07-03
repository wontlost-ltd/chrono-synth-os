/**
 * ADR-0060 T4 集成：ToolEligibilityProjector 端到端（真实 SQLite + 真实 EventBus）。
 *
 * 验证 capability-learned → 据活跃 tool_action_rule 溯源产出 eligibility **建议**（只建议不 grant）：
 *   - 有活跃规则 → 每 tool 一条建议，红线 11 元数据齐全（schema/rule/exam/risk/constraints + expiresAt）；
 *   - 缺 tenantId → drop（红线 7，不投影）；
 *   - capability 学会但无规则 → 不产建议（capability↔tool 解耦）；
 *   - 重新学习（新 ruleVersion）→ 建议单 active 替换（部分唯一索引恒单条）；
 *   - 失败隔离：投影异常不抛进 bus.emit（回调 guard）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { EventBus } from '../../events/event-bus.js';
import { ToolActionRuleStore } from '../../storage/tool-action-rule-store.js';
import { CapabilityToolEligibilityStore } from '../../storage/capability-tool-eligibility-store.js';
import { ToolRuleLearningService, type CandidateToolRule } from '../../intelligence/tool-rule-learning-service.js';
import { ToolEligibilityProjector } from '../../intelligence/tool-eligibility-projector.js';
import { SilentLogger } from '../../utils/logger.js';
import type { McpToolSchema, ToolExamSpec } from '@chrono/kernel';

const SCHEMA: McpToolSchema = {
  type: 'object',
  properties: { customer: {}, currency: {}, action: {} },
  required: ['customer', 'currency', 'action'],
};

function candidate(over: Partial<CandidateToolRule> = {}): CandidateToolRule {
  return {
    personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing',
    schemaVersion: 'v1', ruleVersion: 'r1', contentHash: 'h1', createdBy: 'teacher', expiresAt: null,
    sourceArtifactId: 'artifact-1', riskClass: 'low',
    argMappings: {
      customer: { kind: 'pick', field: 'customerName' },
      currency: { kind: 'enum', field: 'ccy', allow: ['USD', 'EUR'] },
      action: { kind: 'const', value: 'draft' },
    },
    ...over,
  };
}

function goodExam(): ToolExamSpec {
  return {
    examId: 'texam', toolId: 'invoice.issue', capability: 'invoicing', schemaVersion: 'v1', scorerVersion: 'tool-exam-v1',
    cases: [
      { id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'Acme' } },
      { id: 'bad-ccy', kind: 'expect_fail', taskFields: { customerName: 'Acme', ccy: 'JPY' }, expectFailCodes: ['enum_violation'] },
    ],
  };
}

describe('T4 ADR-0060 工具授权资格投影（真实 SQLite + EventBus）', () => {
  let db: IDatabase;
  let bus: EventBus;
  let ruleStore: ToolActionRuleStore;
  let eligibilityStore: CapabilityToolEligibilityStore;
  let learning: ToolRuleLearningService;
  let projector: ToolEligibilityProjector;
  const NOW = 1_000_000;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    bus = new EventBus();
    ruleStore = new ToolActionRuleStore(db, 'tenant-a');
    eligibilityStore = new CapabilityToolEligibilityStore(db, 'tenant-a');
    learning = new ToolRuleLearningService(ruleStore, db, () => NOW);
    projector = new ToolEligibilityProjector({ bus, db, logger: new SilentLogger(), now: () => NOW, ttlMs: 1000 });
    projector.start();
  });

  function emitLearned(over: Record<string, unknown> = {}): void {
    bus.emit('capability-learned', { tenantId: 'tenant-a', personaId: 'p1', capability: 'invoicing', learningRequestId: 'lr1', examScore: 1, learnedAt: NOW, ...over } as never);
  }

  it('★有活跃规则 → 产 eligibility 建议，红线 11 元数据齐全（建议非授权）★', () => {
    assert.ok(learning.learn(candidate(), goodExam(), SCHEMA).ok);
    emitLearned();
    const recs = eligibilityStore.listActive('p1');
    assert.equal(recs.length, 1, '一条工具规则 → 一条建议');
    const r = recs[0];
    assert.equal(r.toolId, 'invoice.issue');
    assert.equal(r.capability, 'invoicing');
    assert.equal(r.schemaVersion, 'v1');
    assert.equal(r.sourceRuleVersion, 'r1');
    assert.equal(r.examSpecVersion, 'texam::tool-exam-v1', '考试溯源 examId::scorerVersion');
    assert.equal(r.riskClass, 'low');
    assert.ok(r.constraintsHash.length > 0, 'constraints 指纹（陈旧判定依据）');
    assert.equal(r.expiresAt, NOW + 1000, '带过期（红线 11 陈旧失效）');
    assert.equal(r.active, true);
  });

  it('★缺 tenantId → drop（红线 7，不投影 eligibility）★', () => {
    assert.ok(learning.learn(candidate(), goodExam(), SCHEMA).ok);
    emitLearned({ tenantId: undefined });
    assert.equal(eligibilityStore.listActive('p1').length, 0, '缺 tenantId 不产建议');
  });

  it('★capability 学会但无工具规则 → 不产建议（capability↔tool 解耦）★', () => {
    emitLearned({ capability: 'pure_knowledge' });
    assert.equal(eligibilityStore.listActive('p1').length, 0);
  });

  it('★重新学习（新 ruleVersion）→ 建议单 active 替换（部分唯一索引恒单条）★', () => {
    assert.ok(learning.learn(candidate({ ruleVersion: 'r1' }), goodExam(), SCHEMA).ok);
    emitLearned();
    assert.equal(eligibilityStore.listActive('p1')[0].sourceRuleVersion, 'r1');
    /* 学新规则版本 → 再投影：旧建议停用，新建议 active，仍单条。 */
    assert.ok(learning.learn(candidate({ ruleVersion: 'r2' }), goodExam(), SCHEMA).ok);
    emitLearned();
    const recs = eligibilityStore.listActive('p1');
    assert.equal(recs.length, 1, '同 key active 恒单条');
    assert.equal(recs[0].sourceRuleVersion, 'r2', '建议指向新规则版本');
  });

  it('★投影失败隔离：回调抛错不传播进 bus.emit★', () => {
    /* 关掉 DB 制造投影内异常；emit 不应抛（TypedEventEmitter guard + projector try-catch 双保险）。 */
    assert.ok(learning.learn(candidate(), goodExam(), SCHEMA).ok);
    db.close();
    assert.doesNotThrow(() => emitLearned(), 'emit 不因订阅者异常抛出');
  });

  /* 红线 11 消费侧闭环：listValidForAuthorization 读时 fail-closed 校验陈旧（过期 / schema 变 / risk 变 / 工具下线）。 */
  describe('listValidForAuthorization（红线 11 陈旧即失效）', () => {
    const CURRENT = new Map([['invoice.issue', { schemaVersion: 'v1', riskClass: 'low' as const }]]);
    beforeEach(() => {
      assert.ok(learning.learn(candidate(), goodExam(), SCHEMA).ok);
      emitLearned();
    });

    it('当前状态一致且未过期 → 有效', () => {
      assert.equal(eligibilityStore.listValidForAuthorization('p1', NOW, CURRENT).length, 1);
    });
    it('★过期（now ≥ expiresAt）→ fail-closed 排除★', () => {
      assert.equal(eligibilityStore.listValidForAuthorization('p1', NOW + 1000, CURRENT).length, 0);
    });
    it('★tool schema 变化 → fail-closed 排除★', () => {
      const changed = new Map([['invoice.issue', { schemaVersion: 'v2', riskClass: 'low' as const }]]);
      assert.equal(eligibilityStore.listValidForAuthorization('p1', NOW, changed).length, 0);
    });
    it('★riskClass 变化（low→high）→ fail-closed 排除★', () => {
      const changed = new Map([['invoice.issue', { schemaVersion: 'v1', riskClass: 'high' as const }]]);
      assert.equal(eligibilityStore.listValidForAuthorization('p1', NOW, changed).length, 0);
    });
    it('★tool 已下线（registry 无此 tool）→ fail-closed 排除★', () => {
      assert.equal(eligibilityStore.listValidForAuthorization('p1', NOW, new Map()).length, 0);
    });
    it('listActive（审计）仍返回全量 active（不过滤过期）——与授权消费入口区分', () => {
      assert.equal(eligibilityStore.listActive('p1').length, 1, 'active 全量含未过期');
    });
  });
});
