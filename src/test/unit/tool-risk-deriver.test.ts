import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRiskSignals, type ToolRiskSource } from '../../workforce/tool-risk-deriver.js';

/* E3 安全：风险信号服务端派生——body 只能上调，不能省略高风险工具绕过审批门（铁律1）。 */
describe('deriveRiskSignals（工具风险服务端派生）', () => {
  const source: ToolRiskSource = {
    get(toolId) {
      if (toolId === 'email.send') return { metadata: { highRisk: true } };
      if (toolId === 'memory.search') return { metadata: { highRisk: false } };
      if (toolId === 'dynamic') return { metadata: { highRisk: false }, isHighRisk: (a) => a.danger === true };
      return undefined; /* 未注册 */
    },
  };

  it('高风险工具(静态 highRisk) → toolRisk=high + requireConfirmation，即便 body 省略', () => {
    const r = deriveRiskSignals(source, 'email.send', {}, undefined);
    assert.equal(r.toolRisk, 'high');
    assert.equal(r.requireConfirmation, true);
  });

  it('低风险工具 + body 无信号 → toolRisk=low，不强制确认', () => {
    const r = deriveRiskSignals(source, 'memory.search', {}, undefined);
    assert.equal(r.toolRisk, 'low');
    assert.equal(r.requireConfirmation, false);
  });

  it('动态高风险(isHighRisk 按 args) → 命中则 high', () => {
    assert.equal(deriveRiskSignals(source, 'dynamic', { danger: true }, undefined).toolRisk, 'high');
    assert.equal(deriveRiskSignals(source, 'dynamic', { danger: false }, undefined).toolRisk, 'low');
  });

  it('未注册工具 → 保守按高风险（不臆造低风险，fail-closed）', () => {
    const r = deriveRiskSignals(source, 'nope', {}, undefined);
    assert.equal(r.toolRisk, 'high');
    assert.equal(r.requireConfirmation, true);
  });

  it('body 只能**上调**：低风险工具 + body 声明 funds → funds 保留', () => {
    const r = deriveRiskSignals(source, 'memory.search', {}, { funds: true });
    assert.equal(r.funds, true);
  });

  it('body **无法下调**工具自身高风险：高风险工具 + body toolRisk=low → 仍 high', () => {
    const r = deriveRiskSignals(source, 'email.send', {}, { toolRisk: 'low' });
    assert.equal(r.toolRisk, 'high', 'body 的 low 不能压过工具 highRisk');
  });

  it('硬信号缺省不臆造：低风险工具 + body 不传硬信号 → 全 false', () => {
    const r = deriveRiskSignals(source, 'memory.search', {}, {});
    assert.equal(r.outboundCommitment, false);
    assert.equal(r.sensitiveData, false);
    assert.equal(r.funds, false);
    assert.equal(r.irreversible, false);
  });
});
