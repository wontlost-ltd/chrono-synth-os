import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import { MetricSelector } from './MetricSelector';
import type { MetricKey } from '../../types';

// 通过 i18n.t() 取断言文案，避免硬编码翻译值。
// 必须在 test() 内部调用 — setup.ts 的 beforeAll 才完成 zh-CN 资源加载。
const tt = (key: string) => i18n.t(key);

describe('MetricSelector', () => {
  it('renders default options as toggle buttons', () => {
    render(<MetricSelector selected={[]} onChange={() => {}} />);
    expect(screen.getByRole('group', { name: tt('aria.metricSelection') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tt('metric.wealth') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tt('metric.healthIndex') })).toBeInTheDocument();
  });

  it('marks selected items as pressed', () => {
    render(<MetricSelector selected={['wealth']} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: tt('metric.wealth') })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: tt('metric.healthIndex') })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange to add a metric', () => {
    const onChange = vi.fn();
    render(<MetricSelector selected={['wealth']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: tt('metric.healthIndex') }));
    expect(onChange).toHaveBeenCalledWith(['wealth', 'healthIndex']);
  });

  it('calls onChange to remove a metric', () => {
    const onChange = vi.fn();
    render(<MetricSelector selected={['wealth', 'healthIndex']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: tt('metric.wealth') }));
    expect(onChange).toHaveBeenCalledWith(['healthIndex']);
  });

  it('uses metricMeta labels when provided', () => {
    const meta = [
      { key: 'wealth' as MetricKey, label: 'Wealth', unit: '¥', range: [0, 1e8] as const },
    ];
    render(<MetricSelector selected={[]} onChange={() => {}} metricMeta={meta} />);
    expect(screen.getByRole('button', { name: 'Wealth' })).toBeInTheDocument();
  });
});
