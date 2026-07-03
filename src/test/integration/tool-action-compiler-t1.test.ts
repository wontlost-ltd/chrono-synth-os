/**
 * ADR-0060 T1 集成：ToolActionCompilerService + ToolActionRuleStore + tool_action_rules 迁移端到端（真实 SQLite）。
 *
 * 验证运行时零-LLM 据确定性规则构造工具调用：空表 fail-closed(no_rule) → 插规则后编译出 ToolCallPlan →
 * 部分唯一索引挡同 key 双 active（红线 10 存储侧）→ 过期规则 fail-closed → 缺字段 fail-closed。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { ToolActionRuleStore, type InsertToolActionRuleInput } from '../../storage/tool-action-rule-store.js';
import { ToolActionCompilerService } from '../../intelligence/tool-action-compiler-service.js';
import type { McpToolSchema } from '@chrono/kernel';

const SCHEMA: McpToolSchema = {
  type: 'object',
  properties: { customer: {}, currency: {}, action: {} },
  required: ['customer', 'currency', 'action'],
};

function ruleInput(over: Partial<InsertToolActionRuleInput> = {}): InsertToolActionRuleInput {
  return {
    id: `rule-${Math.abs(hash(JSON.stringify(over)))}`,
    personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing',
    schemaVersion: 'v1', ruleVersion: 'r1', contentHash: 'h1', createdBy: 'teacher',
    compiledAt: 1000, expiresAt: null, active: true, sourceArtifactId: 'artifact-1',
    examSpecVersion: 'texam::tool-exam-v1', riskClass: 'low',
    argMappings: {
      customer: { kind: 'pick', field: 'customerName' },
      currency: { kind: 'enum', field: 'ccy', allow: ['USD', 'EUR'] },
      action: { kind: 'const', value: 'draft' },
    },
    ...over,
  };
}
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

describe('T1 ADR-0060 ToolActionCompiler 端到端（真实 SQLite）', () => {
  let db: IDatabase;
  let store: ToolActionRuleStore;
  let svc: ToolActionCompilerService;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new ToolActionRuleStore(db, 'tenant-a');
    svc = new ToolActionCompilerService(store, 'tenant-a', () => 2000);
  });

  const req = (fields: Record<string, unknown>) => ({
    personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing',
    toolSchema: SCHEMA, schemaVersion: 'v1', taskFields: fields,
  });

  it('★空表 → fail-closed no_rule（T1 阶段规则表空，一切 fail-closed 不改现有行为）★', () => {
    const r = svc.compile(req({ customerName: 'Acme', ccy: 'USD' }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'no_rule');
  });

  it('★插规则 → 编译出确定性 ToolCallPlan★', () => {
    store.insert(ruleInput());
    const r = svc.compile(req({ customerName: 'Acme', ccy: 'USD' }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.arguments, { action: 'draft', currency: 'USD', customer: 'Acme' });
    assert.equal(r.plan.toolId, 'invoice.issue');
    assert.match(r.plan.idempotencyKey, /^tcall_[0-9a-f]{8}$/);
  });

  it('★部分唯一索引挡同 key 双 active（红线 10 存储侧）★', () => {
    store.insert(ruleInput({ id: 'a', ruleVersion: 'r1' }));
    assert.throws(
      () => store.insert(ruleInput({ id: 'b', ruleVersion: 'r2' })), /* 同 (tenant,persona,tool,cap,schema) active */
      /UNIQUE|constraint/i,
      '同 key 第二个 active 规则应被部分唯一索引拒绝',
    );
  });

  it('★同 key 一 active 一 inactive 可共存 → 唯一命中 active → 编译成功★', () => {
    store.insert(ruleInput({ id: 'old', ruleVersion: 'r0', active: false }));
    store.insert(ruleInput({ id: 'new', ruleVersion: 'r1', active: true }));
    const r = svc.compile(req({ customerName: 'Acme', ccy: 'EUR' }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.plan.ruleVersion, 'r1');
  });

  it('★过期规则 → fail-closed rule_expired★', () => {
    store.insert(ruleInput({ expiresAt: 1500 })); /* now=2000 > 1500 */
    const r = svc.compile(req({ customerName: 'Acme', ccy: 'USD' }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'rule_expired');
  });

  it('★缺任务字段 → fail-closed missing_field（不填默认）★', () => {
    store.insert(ruleInput());
    const r = svc.compile(req({ ccy: 'USD' })); /* 缺 customerName */
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'missing_field');
  });

  it('★有 active 规则但 schemaVersion 不符 → fail-closed schema_mismatch（tool schema 变化，规则失效供重训）★', () => {
    store.insert(ruleInput({ schemaVersion: 'v0' }));
    const r = svc.compile(req({ customerName: 'Acme', ccy: 'USD' })); /* 请求 schemaVersion=v1 */
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'schema_mismatch');
  });

  it('★跨租户隔离：tenant-b 的编译器看不到 tenant-a 的规则★', () => {
    store.insert(ruleInput());
    const svcB = new ToolActionCompilerService(new ToolActionRuleStore(db, 'tenant-b'), 'tenant-b', () => 2000);
    const r = svcB.compile(req({ customerName: 'Acme', ccy: 'USD' }));
    assert.equal(r.ok, false, 'tenant-b 无规则 → no_rule');
  });
});
