import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextFinanceState, DEFAULT_FINANCE_CONFIG } from '../../simulation/career-finance-model.js';
import type { FinanceState } from '../../types/life-simulation.js';

const PREV: FinanceState = { income: 300000, savings: 500000, wealth: 500000 };

describe('nextFinanceState', () => {
  it('默认收入按基础增长率增长', () => {
    const result = nextFinanceState(PREV, {
      branchConditions: {}, stressTest: false, year: 1, familyExpense: 0,
    }, DEFAULT_FINANCE_CONFIG);
    const expected = PREV.income * (1 + DEFAULT_FINANCE_CONFIG.baseIncomeGrowth);
    assert.ok(Math.abs(result.income - expected) < 1, `income=${result.income} expected≈${expected}`);
  });

  it('压力测试冻结收入增长', () => {
    const result = nextFinanceState(PREV, {
      branchConditions: {}, stressTest: true, year: 1, familyExpense: 0,
    }, DEFAULT_FINANCE_CONFIG);
    assert.equal(result.income, PREV.income);
  });

  it('incomeOverride 直接设置收入', () => {
    const result = nextFinanceState(PREV, {
      branchConditions: { incomeOverride: 500000 }, stressTest: false, year: 1, familyExpense: 0,
    }, DEFAULT_FINANCE_CONFIG);
    assert.equal(result.income, 500000);
  });

  it('incomeMultiplier 乘以当前收入', () => {
    const result = nextFinanceState(PREV, {
      branchConditions: { incomeMultiplier: 2 }, stressTest: false, year: 1, familyExpense: 0,
    }, DEFAULT_FINANCE_CONFIG);
    const expected = PREV.income * (1 + DEFAULT_FINANCE_CONFIG.baseIncomeGrowth) * 2;
    assert.ok(Math.abs(result.income - expected) < 1, `income=${result.income} expected≈${expected}`);
  });

  it('savingsImpact 影响储蓄', () => {
    const withImpact = nextFinanceState(PREV, {
      branchConditions: { savingsImpact: -200000 }, stressTest: false, year: 1, familyExpense: 0,
    }, DEFAULT_FINANCE_CONFIG);
    const without = nextFinanceState(PREV, {
      branchConditions: {}, stressTest: false, year: 1, familyExpense: 0,
    }, DEFAULT_FINANCE_CONFIG);
    assert.ok(withImpact.savings < without.savings, `${withImpact.savings} should < ${without.savings}`);
  });

  it('家庭额外支出减少储蓄', () => {
    const noExpense = nextFinanceState(PREV, {
      branchConditions: {}, stressTest: false, year: 1, familyExpense: 0,
    }, DEFAULT_FINANCE_CONFIG);
    const withExpense = nextFinanceState(PREV, {
      branchConditions: {}, stressTest: false, year: 1, familyExpense: 100000,
    }, DEFAULT_FINANCE_CONFIG);
    assert.ok(withExpense.savings < noExpense.savings);
  });

  it('财富不低于 0', () => {
    const result = nextFinanceState(
      { income: 0, savings: -100000, wealth: 0 },
      { branchConditions: { incomeOverride: 0 }, stressTest: false, year: 1, familyExpense: 50000 },
      DEFAULT_FINANCE_CONFIG,
    );
    assert.ok(result.wealth >= 0, `wealth=${result.wealth} should >= 0`);
  });

  it('incomeMultiplier=0 时收入为 0', () => {
    const result = nextFinanceState(PREV, {
      branchConditions: { incomeMultiplier: 0 }, stressTest: false, year: 1, familyExpense: 0,
    }, DEFAULT_FINANCE_CONFIG);
    assert.equal(result.income, 0);
  });
});
