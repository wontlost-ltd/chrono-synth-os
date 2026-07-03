/**
 * 工具考试评分 + lint 单元测试（ADR-0060 T2）。
 *
 * 锁住：正例 arguments 精确匹配才过、错构造→不过；expect_fail 用例正确 fail-closed（越权枚举/缺字段）才过、
 * 应拒未拒→不过；全过才 passed（无小错容忍）；lint 反作弊（无用例 / 无正例 / 无 fail-closed 用例 / 重复 id /
 * schemaVersion 不符）。全确定性、零-LLM。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreToolExam, lintToolExamSpec,
  type ToolActionRule, type ToolExamSpec,
} from '../src/index.js';
import type { McpToolSchema } from '../src/domain/agent/mcp-protocol-types.js';

function rule(): ToolActionRule {
  return {
    tenantId: 't1', personaId: 'p1', toolId: 'invoice.issue', capability: 'invoicing',
    schemaVersion: 'v1', ruleVersion: 'r1', contentHash: 'h1', createdBy: 'teacher', compiledAt: 1000,
    expiresAt: null, active: true,
    argMappings: {
      customer: { kind: 'pick', field: 'customerName' },
      currency: { kind: 'enum', field: 'ccy', allow: ['USD', 'EUR'] },
      action: { kind: 'const', value: 'draft' },
    },
  };
}

const SCHEMA: McpToolSchema = {
  type: 'object',
  properties: { customer: {}, currency: {}, action: {} },
  required: ['customer', 'currency', 'action'],
};

/** 健康 spec：1 正例（精确匹配）+ 2 fail-closed（枚举越界 / 缺字段）。 */
function goodSpec(): ToolExamSpec {
  return {
    examId: 'texam-invoice', toolId: 'invoice.issue', capability: 'invoicing', schemaVersion: 'v1',
    scorerVersion: 'tool-exam-v1',
    cases: [
      { id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'Acme' } },
      { id: 'bad-ccy', kind: 'expect_fail', taskFields: { customerName: 'Acme', ccy: 'JPY' }, expectFailCodes: ['enum_violation'] },
      { id: 'missing', kind: 'expect_fail', taskFields: { ccy: 'USD' }, expectFailCodes: ['missing_field'] },
    ],
  };
}

describe('scoreToolExam（ADR-0060 T2）', () => {
  it('★合格规则 → 全用例过 → passed（coverage 1）★', () => {
    const r = scoreToolExam(rule(), goodSpec(), SCHEMA, 2000);
    assert.equal(r.passed, true);
    assert.equal(r.coverage, 1);
  });

  it('★错构造（arguments 不符预期）→ 不过★', () => {
    const spec = goodSpec();
    /* 篡改期望：正例期望 customer=WRONG，规则实际产 Acme → 不匹配 → 该例不过 → 全局不过。 */
    const tampered: ToolExamSpec = { ...spec, cases: [{ id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'WRONG' } }, ...spec.cases.slice(1)] };
    const r = scoreToolExam(rule(), tampered, SCHEMA, 2000);
    assert.equal(r.passed, false);
    assert.ok(r.caseResults.find((c) => c.caseId === 'ok')?.passed === false);
  });

  it('★安全场景「应拒未拒」→ 不过（expect_fail 但规则竟编译成功）★', () => {
    /* 用一个不越界的 ccy 但标成 expect_fail → 规则会编译成功 → 该 expect_fail 例不过。 */
    const spec: ToolExamSpec = { ...goodSpec(), cases: [{ id: 'should-fail-but-ok', kind: 'expect_fail', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectFailCodes: ['enum_violation'] }] };
    const r = scoreToolExam(rule(), spec, SCHEMA, 2000);
    assert.equal(r.passed, false);
  });

  it('★expect_fail code 不符 → 不过（fail 了但不是期望的 code）★', () => {
    const spec: ToolExamSpec = { ...goodSpec(), cases: [{ id: 'wrong-code', kind: 'expect_fail', taskFields: { ccy: 'USD' }, expectFailCodes: ['enum_violation'] }] }; /* 实际 missing_field */
    const r = scoreToolExam(rule(), spec, SCHEMA, 2000);
    assert.equal(r.passed, false);
  });
});

describe('lintToolExamSpec（ADR-0060 T2 反作弊）', () => {
  it('健康 spec → ok', () => {
    assert.equal(lintToolExamSpec(goodSpec()).ok, true);
  });

  it('★无 fail-closed 用例 → no_failclosed_case（不考安全=反作弊漏洞）★', () => {
    const spec: ToolExamSpec = { ...goodSpec(), cases: [{ id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'Acme' } }] };
    const r = lintToolExamSpec(spec);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((x) => x.code === 'no_failclosed_case'));
  });

  it('无用例 → no_cases + too_few_positive + no_failclosed_case', () => {
    const r = lintToolExamSpec({ ...goodSpec(), cases: [] });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((x) => x.code === 'no_cases'));
  });

  it('重复用例 id → duplicate_case_id', () => {
    const spec: ToolExamSpec = { ...goodSpec(), cases: [...goodSpec().cases, { id: 'ok', kind: 'expect_fail', taskFields: {}, expectFailCodes: ['missing_field'] }] };
    assert.ok(lintToolExamSpec(spec).violations.some((x) => x.code === 'duplicate_case_id'));
  });

  it('★schemaVersion 与规则不符 → schema_version_mismatch★', () => {
    const r = lintToolExamSpec(goodSpec(), { toolId: 'invoice.issue', capability: 'invoicing', schemaVersion: 'v0' });
    assert.ok(r.violations.some((x) => x.code === 'schema_version_mismatch'));
  });

  it('★目标绑定：toolId/capability 与规则不符 → 违规（Codex T2 复审 S3a）★', () => {
    assert.ok(lintToolExamSpec(goodSpec(), { toolId: 'wrong.tool', capability: 'invoicing', schemaVersion: 'v1' }).ok === false);
    assert.ok(lintToolExamSpec(goodSpec(), { toolId: 'invoice.issue', capability: 'wrong_cap', schemaVersion: 'v1' }).ok === false);
    /* 全维一致 → ok。 */
    assert.equal(lintToolExamSpec(goodSpec(), { toolId: 'invoice.issue', capability: 'invoicing', schemaVersion: 'v1' }).ok, true);
  });
});

describe('scoreToolExam 目标绑定（S3b）', () => {
  it('★规则 toolId 与 spec.toolId 不符 → expect_args 例不过（不假阳性）★', () => {
    const misboundRule: ToolActionRule = { ...rule(), toolId: 'other.tool' };
    /* spec.toolId=invoice.issue，规则产 other.tool → 即便 args 对也不过。 */
    const r = scoreToolExam(misboundRule, { ...goodSpec(), cases: [{ id: 'ok', kind: 'expect_args', taskFields: { customerName: 'Acme', ccy: 'USD' }, expectArgs: { action: 'draft', currency: 'USD', customer: 'Acme' } }] }, SCHEMA, 2000);
    assert.equal(r.passed, false);
    assert.match(r.caseResults[0].detail, /toolId 不符/);
  });
});
