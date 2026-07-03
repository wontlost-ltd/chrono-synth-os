/**
 * 工具动作编译器单元测试（ADR-0060 R1 / T1）。
 *
 * 锁住确定性核心不变量：resolveActiveRule 唯一命中 / 无 / 冲突 / 过期 fail-closed；compileToolCall
 * 的 pick/const/enum/template 求值 + 缺字段/枚举越界/缺必填项 fail-closed（绝不填默认）；idempotencyKey
 * 与 arguments 键序确定性可复现。全零-LLM、纯函数。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveActiveRule, compileToolCall,
  type ToolActionRule, type ToolRuleKey,
} from '../src/index.js';
import type { McpToolSchema } from '../src/domain/agent/mcp-protocol-types.js';

const KEY: ToolRuleKey = { tenantId: 't1', personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing', schemaVersion: 'v1' };

function rule(over: Partial<ToolActionRule> = {}): ToolActionRule {
  return {
    tenantId: 't1', personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing',
    schemaVersion: 'v1', ruleVersion: 'r1', contentHash: 'h1', createdBy: 'teacher', compiledAt: 1000,
    expiresAt: null, active: true,
    argMappings: {
      customer: { kind: 'pick', field: 'customerName' },
      currency: { kind: 'enum', field: 'ccy', allow: ['USD', 'EUR'] },
      memo: { kind: 'template', segments: [{ literal: '发票-' }, { field: 'topic' }] },
      action: { kind: 'const', value: 'draft' },
    },
    ...over,
  };
}

const SCHEMA: McpToolSchema = {
  type: 'object',
  properties: { customer: {}, currency: {}, memo: {}, action: {} },
  required: ['customer', 'currency', 'action'],
};

const FIELDS = { customerName: 'Acme', ccy: 'USD', topic: '季度服务' };

describe('resolveActiveRule（ADR-0060 T1）', () => {
  it('唯一 active 命中 → ok', () => {
    const r = resolveActiveRule([rule()], KEY, 2000);
    assert.equal(r.ok, true);
  });

  it('无匹配 → no_rule fail-closed', () => {
    const r = resolveActiveRule([rule({ capability: 'other' })], KEY, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'no_rule');
  });

  it('★同 key 多 active → rule_conflict fail-closed（红线 10 不猜）★', () => {
    const r = resolveActiveRule([rule({ ruleVersion: 'r1' }), rule({ ruleVersion: 'r2' })], KEY, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'rule_conflict');
  });

  it('inactive 不计入（同 key 一 active 一 inactive → 唯一命中 active）', () => {
    const r = resolveActiveRule([rule({ ruleVersion: 'r1' }), rule({ ruleVersion: 'r0', active: false })], KEY, 2000);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.rule.ruleVersion, 'r1');
  });

  it('★过期规则 → rule_expired fail-closed★', () => {
    const r = resolveActiveRule([rule({ expiresAt: 1500 })], KEY, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'rule_expired');
  });

  it('★有 active 规则但 schemaVersion 不符 → schema_mismatch（可达，供治理重训）★', () => {
    const r = resolveActiveRule([rule({ schemaVersion: 'v0' })], KEY, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'schema_mismatch'); /* 非 no_rule：该场景有 active 规则只是版本旧 */
  });

  it('该场景压根无 active 规则 → no_rule（区别于 schema_mismatch）', () => {
    const r = resolveActiveRule([rule({ toolId: 'other.tool' })], KEY, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'no_rule');
  });

  it('★畸形 DSL（未知 kind）→ invalid_mapping 受控 fail-closed，不抛异常（S1 修复）★', () => {
    const bad = rule({ argMappings: { x: { kind: 'bogus' } as never } });
    const r = compileToolCall(bad, FIELDS, SCHEMA, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'invalid_mapping');
  });

  it('★畸形 DSL（映射值 null）→ invalid_mapping 不抛异常（S1 二轮：入口非空守卫）★', () => {
    const bad = rule({ argMappings: { x: null as never } });
    let r: ReturnType<typeof compileToolCall> | undefined;
    assert.doesNotThrow(() => { r = compileToolCall(bad, FIELDS, SCHEMA, 2000); });
    assert.ok(r && !r.ok);
    if (r && !r.ok) assert.equal(r.code, 'invalid_mapping');
  });

  it('★构造值类型不符 schema type → invalid_arguments（S2 类型校验）★', () => {
    /* action const 是 string 'draft'，但把 schema 的 action 声明成 number → 类型不符拒。 */
    const numSchema: McpToolSchema = { type: 'object', properties: { customer: {}, currency: {}, action: { type: 'number' } }, required: ['customer', 'currency', 'action'] };
    const r = compileToolCall(rule(), FIELDS, numSchema, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'invalid_arguments');
  });

  it('★additionalProperties=false + 规则产多余参数 → invalid_arguments★', () => {
    const strictSchema: McpToolSchema = { type: 'object', properties: { customer: {} }, required: ['customer'], additionalProperties: false };
    const r = compileToolCall(rule(), FIELDS, strictSchema, 2000); /* 规则还产 currency/action，不在 schema */
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'invalid_arguments');
  });
});

describe('compileToolCall（ADR-0060 T1）', () => {
  it('★确定性构造 arguments（pick/const/enum/template 全求值）★', () => {
    const r = compileToolCall(rule(), FIELDS, SCHEMA, 2000);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.arguments, { action: 'draft', currency: 'USD', customer: 'Acme', memo: '发票-季度服务' });
    assert.equal(r.plan.toolId, 'invoice.issue');
    assert.equal(r.plan.ruleVersion, 'r1');
  });

  it('★缺任务字段 → missing_field fail-closed（不填默认）★', () => {
    const r = compileToolCall(rule(), { ccy: 'USD', topic: 'x' }, SCHEMA, 2000); /* 缺 customerName */
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'missing_field');
    assert.equal(r.failClosed, true);
  });

  it('★枚举越界 → enum_violation fail-closed★', () => {
    const r = compileToolCall(rule(), { ...FIELDS, ccy: 'JPY' }, SCHEMA, 2000); /* JPY 不在白名单 */
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'enum_violation');
  });

  it('★缺 tool 必填项 → invalid_arguments fail-closed★', () => {
    /* 规则只构造 customer，但 schema required 含 currency/action → 缺 → fail-closed。 */
    const partial = rule({ argMappings: { customer: { kind: 'pick', field: 'customerName' } } });
    const r = compileToolCall(partial, FIELDS, SCHEMA, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'invalid_arguments');
  });

  it('★确定性可复现：同输入 → 同 arguments 键序 + 同 idempotencyKey★', () => {
    const a = compileToolCall(rule(), FIELDS, SCHEMA, 2000);
    const b = compileToolCall(rule(), FIELDS, SCHEMA, 9999); /* now 不同也不影响构造（红线 9 禁时间进构造） */
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.equal(JSON.stringify(a.plan.arguments), JSON.stringify(b.plan.arguments), '键序稳定');
    assert.equal(a.plan.idempotencyKey, b.plan.idempotencyKey, '幂等键确定性');
    assert.match(a.plan.idempotencyKey, /^tcall_[0-9a-f]{8}$/);
  });

  it('★过期在 compile 阶段也二次守（resolve 后 now 推进过期）→ rule_expired★', () => {
    const r = compileToolCall(rule({ expiresAt: 1500 }), FIELDS, SCHEMA, 2000);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'rule_expired');
  });
});
