/**
 * ADR-0060 T3 集成：ToolRuleLearningService 门控学习端到端（真实 SQLite）。
 *
 * 验证候选规则**过门才入表**：过考 → 落表 + 运行时编译器随即可用 → 二次学习停旧 active 单条替换；
 * 未过考（越权用例应拒未拒）→ 拒绝不落表；畸形规则 → rule_lint 拒；考试无 fail-closed 用例 → exam_lint 拒。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { ToolActionRuleStore } from '../../storage/tool-action-rule-store.js';
import { ToolActionCompilerService } from '../../intelligence/tool-action-compiler-service.js';
import { ToolRuleLearningService, type CandidateToolRule } from '../../intelligence/tool-rule-learning-service.js';
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
    sourceArtifactId: 'artifact-1',
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

describe('T3 ADR-0060 工具规则门控学习（真实 SQLite）', () => {
  let db: IDatabase;
  let store: ToolActionRuleStore;
  let compiler: ToolActionCompilerService;
  let learning: ToolRuleLearningService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new ToolActionRuleStore(db, 'tenant-a');
    compiler = new ToolActionCompilerService(store, 'tenant-a', () => 2000);
    learning = new ToolRuleLearningService(store, db, () => 2000);
  });

  it('★过考 → 落表 + 运行时编译器随即可用★', () => {
    const r = learning.learn(candidate(), goodExam(), SCHEMA);
    assert.equal(r.ok && r.learned, true);
    /* 落表后运行时编译器能查到规则并构造调用。 */
    const plan = compiler.compile({ personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing', toolSchema: SCHEMA, schemaVersion: 'v1', taskFields: { customerName: 'Acme', ccy: 'USD' } });
    assert.equal(plan.ok, true);
    if (plan.ok) assert.deepEqual(plan.plan.arguments, { action: 'draft', currency: 'USD', customer: 'Acme' });
    /* 红线 6：落表规则来源可追溯（provenance 落库）。 */
    if (r.ok) assert.equal(store.getSourceArtifactId(r.ruleId), 'artifact-1', 'provenance 落库可审计');
  });

  it('★缺 provenance（sourceArtifactId 空）→ provenance 门拒，不跑 lint/考试不落表（红线 6 禁直灌）★', () => {
    const r = learning.learn(candidate({ sourceArtifactId: '' }), goodExam(), SCHEMA);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.stage, 'provenance');
    /* 未落表：运行时 fail-closed。 */
    const plan = compiler.compile({ personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing', toolSchema: SCHEMA, schemaVersion: 'v1', taskFields: { customerName: 'Acme', ccy: 'USD' } });
    assert.equal(plan.ok, false);
  });

  it('★未过考（应拒未拒）→ 拒绝不落表★', () => {
    /* lint-clean 考试（有正例+有 fail-closed 用例），但其中一个 expect_fail 用例给的是合法 USD——规则会
     * 编译成功 → 该 fail 例「应拒未拒」不过 → 考试 stage 拒。 */
    const badExam: ToolExamSpec = {
      ...goodExam(),
      cases: [
        { id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'Acme' } },
        { id: 'should-fail-but-ok', kind: 'expect_fail', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectFailCodes: ['enum_violation'] },
      ],
    };
    const r = learning.learn(candidate(), badExam, SCHEMA);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.stage, 'exam');
    /* 未落表：运行时编译 fail-closed no_rule。 */
    const plan = compiler.compile({ personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing', toolSchema: SCHEMA, schemaVersion: 'v1', taskFields: { customerName: 'Acme', ccy: 'USD' } });
    assert.equal(plan.ok, false);
  });

  it('★畸形规则（未知 kind）→ rule_lint 拒，不跑考试不落表★', () => {
    const bad = candidate({ argMappings: { x: { kind: 'bogus' } as never } });
    const r = learning.learn(bad, goodExam(), SCHEMA);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.stage, 'rule_lint');
  });

  it('★考试无 fail-closed 用例 → exam_lint 拒（反作弊）★', () => {
    const noFailExam: ToolExamSpec = { ...goodExam(), cases: [{ id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'Acme' } }] };
    const r = learning.learn(candidate(), noFailExam, SCHEMA);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.stage, 'exam_lint');
  });

  it('★二次学习 → 停旧 active 单条替换（部分唯一索引恒单条）★', () => {
    const first = learning.learn(candidate({ ruleVersion: 'r1' }), goodExam(), SCHEMA);
    assert.ok(first.ok && first.learned);
    if (first.ok) assert.equal(first.deactivatedPriorCount, 0);
    /* 第二次同 key 学习：应停掉 r1、插 r2，不撞部分唯一索引。 */
    const second = learning.learn(candidate({ ruleVersion: 'r2' }), goodExam(), SCHEMA);
    assert.ok(second.ok && second.learned);
    if (second.ok) assert.equal(second.deactivatedPriorCount, 1, '停用了 1 条旧 active');
    /* 运行时只命中新 active（无 rule_conflict）。 */
    const plan = compiler.compile({ personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing', toolSchema: SCHEMA, schemaVersion: 'v1', taskFields: { customerName: 'Acme', ccy: 'USD' } });
    assert.equal(plan.ok, true, '单 active → 无冲突，正常编译');
    if (plan.ok) assert.equal(plan.plan.ruleVersion, 'r2', '命中新版本');
  });

  it('★绕 service 直写 store.insert 空 provenance → 存储层 fail-closed 抛错（红线 6 双门兜底）★', () => {
    assert.throws(
      () => store.insert({
        id: 'x', personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing', schemaVersion: 'v1',
        ruleVersion: 'r1', contentHash: 'h1', argMappings: { action: { kind: 'const', value: 'draft' } },
        createdBy: 'teacher', compiledAt: 2000, expiresAt: null, active: true, sourceArtifactId: '',
      }),
      /source_artifact_id 不得为空/,
    );
  });
});
