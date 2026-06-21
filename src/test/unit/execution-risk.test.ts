import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessExecutionRisk, routeApproval } from '../../workforce/execution-risk.js';

/* ADR-0055 D2：有效风险只升不降 + 审批路由。确定性零-LLM。 */
describe('assessExecutionRisk（铁律1：风险只升不降）', () => {
  it('low 任务无硬信号 → low，无需人类', () => {
    const a = assessExecutionRisk({ taskRisk: 'low' });
    assert.equal(a.effectiveRisk, 'low');
    assert.equal(a.requiresHuman, false);
  });

  it('medium 任务 → medium，不强制人类', () => {
    const a = assessExecutionRisk({ taskRisk: 'medium' });
    assert.equal(a.effectiveRisk, 'medium');
    assert.equal(a.requiresHuman, false);
  });

  it('high 任务 → high + 必须人类', () => {
    const a = assessExecutionRisk({ taskRisk: 'high' });
    assert.equal(a.effectiveRisk, 'high');
    assert.equal(a.requiresHuman, true);
  });

  it('★铁律1★：medium 任务 + 敏感数据 → 强制 high + 必须人类（不能被 medium 降级）', () => {
    const a = assessExecutionRisk({ taskRisk: 'medium', sensitiveData: true });
    assert.equal(a.effectiveRisk, 'high');
    assert.equal(a.requiresHuman, true);
    assert.match(a.rationale, /敏感数据/);
  });

  it('★铁律1★：low 任务 + 资金/对外/不可逆 任一 → 强制 high + 必须人类', () => {
    for (const sig of [{ funds: true }, { outboundCommitment: true }, { irreversible: true }]) {
      const a = assessExecutionRisk({ taskRisk: 'low', ...sig });
      assert.equal(a.effectiveRisk, 'high', `${JSON.stringify(sig)} → high`);
      assert.equal(a.requiresHuman, true);
    }
  });

  it('取 max(任务风险, 工具风险)', () => {
    assert.equal(assessExecutionRisk({ taskRisk: 'low', toolRisk: 'medium' }).effectiveRisk, 'medium');
    assert.equal(assessExecutionRisk({ taskRisk: 'medium', toolRisk: 'low' }).effectiveRisk, 'medium');
  });

  it('requireConfirmation 至少顶到 medium', () => {
    assert.equal(assessExecutionRisk({ taskRisk: 'low', requireConfirmation: true }).effectiveRisk, 'medium');
  });

  it('确定性：相同信号相同评估', () => {
    assert.deepEqual(assessExecutionRisk({ taskRisk: 'medium', funds: true }), assessExecutionRisk({ taskRisk: 'medium', funds: true }));
  });
});

describe('routeApproval（审批路由）', () => {
  it('low → no_approval', () => {
    assert.equal(routeApproval(assessExecutionRisk({ taskRisk: 'low' }), false).kind, 'no_approval');
  });
  it('high/必须人类 → human_only（即便 policy 允许 worker 审批）', () => {
    assert.equal(routeApproval(assessExecutionRisk({ taskRisk: 'high' }), true).kind, 'human_only');
    assert.equal(routeApproval(assessExecutionRisk({ taskRisk: 'medium', funds: true }), true).kind, 'human_only');
  });
  it('medium + policy 开 worker 审批 → org_or_human', () => {
    assert.equal(routeApproval(assessExecutionRisk({ taskRisk: 'medium' }), true).kind, 'org_or_human');
  });
  it('medium + policy 关 → human_only（默认人类）', () => {
    assert.equal(routeApproval(assessExecutionRisk({ taskRisk: 'medium' }), false).kind, 'human_only');
  });
});
