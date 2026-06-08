import { describe, it, expect } from 'vitest';

interface PathDraft {
  id: string;
  label: string;
  description: string;
  income: number;
  savings: number;
  branches: Array<{ label: string; probability: number; conditions: Record<string, number> }>;
}

function validateStep0(paths: PathDraft[]): string | null {
  for (let i = 0; i < paths.length; i++) {
    if (!paths[i]!.id.trim()) return `路径 ${i + 1} 的 ID 不能为空`;
    if (!paths[i]!.label.trim()) return `路径 ${i + 1} 的名称不能为空`;
  }
  const ids = paths.map(p => p.id.trim());
  if (new Set(ids).size !== ids.length) return '路径 ID 不能重复';
  return null;
}

function validateStep1(paths: PathDraft[]): string | null {
  for (const p of paths) {
    if (p.branches.length === 0) continue;
    for (const br of p.branches) {
      if (!br.label.trim()) return `路径 "${p.label}" 中有分支名称为空`;
      if (Number.isNaN(br.probability)) return `分支 "${br.label}" 的概率不是有效数字`;
      if (br.probability < 0 || br.probability > 1) return `分支 "${br.label}" 的概率必须在 0-1 之间`;
    }
    const sum = p.branches.reduce((s, br) => s + br.probability, 0);
    if (Math.abs(sum - 1) > 0.01 && p.branches.length > 0) {
      return `路径 "${p.label}" 分支概率之和 (${sum.toFixed(2)}) 应为 1.0`;
    }
  }
  return null;
}

function validateStep2(age: number, horizonYears: number, paths: PathDraft[]): string | null {
  if (Number.isNaN(age) || age < 1 || age > 120) return '年龄必须在 1-120 之间';
  if (Number.isNaN(horizonYears) || horizonYears < 1 || horizonYears > 80) return '模拟年数必须在 1-80 之间';
  for (const p of paths) {
    if (!Number.isFinite(p.income) || p.income < 0) return `路径 "${p.label}" 的收入必须是有效的非负数`;
    if (!Number.isFinite(p.savings) || p.savings < 0) return `路径 "${p.label}" 的储蓄必须是有效的非负数`;
  }
  return null;
}

const validPath: PathDraft = {
  id: 'stable', label: '稳定', description: '保持现状',
  income: 300000, savings: 500000, branches: [],
};

describe('validateStep0', () => {
  it('passes valid paths', () => {
    expect(validateStep0([validPath])).toBeNull();
  });

  it('rejects empty ID', () => {
    expect(validateStep0([{ ...validPath, id: '' }])).toContain('ID 不能为空');
  });

  it('rejects empty label', () => {
    expect(validateStep0([{ ...validPath, label: '  ' }])).toContain('名称不能为空');
  });

  it('rejects duplicate IDs', () => {
    expect(validateStep0([validPath, { ...validPath }])).toContain('不能重复');
  });

  it('passes different IDs', () => {
    expect(validateStep0([validPath, { ...validPath, id: 'adventure' }])).toBeNull();
  });
});

describe('validateStep1', () => {
  it('passes paths with no branches', () => {
    expect(validateStep1([validPath])).toBeNull();
  });

  it('passes valid branches summing to 1', () => {
    const path = {
      ...validPath,
      branches: [
        { label: 'A', probability: 0.6, conditions: {} },
        { label: 'B', probability: 0.4, conditions: {} },
      ],
    };
    expect(validateStep1([path])).toBeNull();
  });

  it('rejects empty branch label', () => {
    const path = {
      ...validPath,
      branches: [{ label: '', probability: 0.5, conditions: {} }],
    };
    expect(validateStep1([path])).toContain('名称为空');
  });

  it('rejects probability out of range', () => {
    const path = {
      ...validPath,
      branches: [{ label: 'A', probability: 1.5, conditions: {} }],
    };
    expect(validateStep1([path])).toContain('0-1');
  });

  it('rejects probabilities not summing to 1', () => {
    const path = {
      ...validPath,
      branches: [
        { label: 'A', probability: 0.3, conditions: {} },
        { label: 'B', probability: 0.3, conditions: {} },
      ],
    };
    expect(validateStep1([path])).toContain('1.0');
  });
});

describe('validateStep2', () => {
  it('passes valid params', () => {
    expect(validateStep2(35, 10, [validPath])).toBeNull();
  });

  it('rejects age < 1', () => {
    expect(validateStep2(0, 10, [validPath])).toContain('年龄');
  });

  it('rejects age > 120', () => {
    expect(validateStep2(121, 10, [validPath])).toContain('年龄');
  });

  it('rejects horizonYears < 1', () => {
    expect(validateStep2(35, 0, [validPath])).toContain('模拟年数');
  });

  it('rejects negative income', () => {
    expect(validateStep2(35, 10, [{ ...validPath, income: -1 }])).toContain('收入');
  });

  it('rejects NaN savings', () => {
    expect(validateStep2(35, 10, [{ ...validPath, savings: NaN }])).toContain('储蓄');
  });
});
