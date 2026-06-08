import { describe, it, expect } from 'vitest';
import { formatCurrency, formatPercent, formatMetricValue, trendDirection } from './format';

describe('formatCurrency', () => {
  it('formats values >= 1亿 with 亿 suffix', () => {
    expect(formatCurrency(1_5000_0000)).toBe('1.50亿');
    expect(formatCurrency(10_0000_0000)).toBe('10.00亿');
  });

  it('formats negative values >= 1亿', () => {
    expect(formatCurrency(-2_0000_0000)).toBe('-2.00亿');
  });

  it('formats values >= 1万 with 万 suffix', () => {
    expect(formatCurrency(5_0000)).toBe('5.0万');
    expect(formatCurrency(12_3456)).toBe('12.3万');
  });

  it('formats small values with locale string', () => {
    const result = formatCurrency(1234);
    expect(result).toContain('1');
    expect(result).toContain('234');
  });

  it('handles zero', () => {
    expect(formatCurrency(0)).toBe('0');
  });
});

describe('formatPercent', () => {
  it('formats decimal as percentage', () => {
    expect(formatPercent(0.5)).toBe('50.0%');
    expect(formatPercent(1)).toBe('100.0%');
  });

  it('respects custom digits', () => {
    expect(formatPercent(0.1234, 2)).toBe('12.34%');
    expect(formatPercent(0.1, 0)).toBe('10%');
  });

  it('handles zero', () => {
    expect(formatPercent(0)).toBe('0.0%');
  });

  it('handles negative values', () => {
    expect(formatPercent(-0.05)).toBe('-5.0%');
  });
});

describe('formatMetricValue', () => {
  it('returns dash for NaN', () => {
    expect(formatMetricValue(NaN, '')).toBe('-');
  });

  it('returns dash for null-ish', () => {
    expect(formatMetricValue(null as unknown as number, '')).toBe('-');
  });

  it('formats currency with ¥ unit', () => {
    expect(formatMetricValue(5_0000, '¥')).toBe('¥5.0万');
  });

  it('formats currency with ¥/年 unit', () => {
    expect(formatMetricValue(1200, '¥/年')).toContain('¥');
  });

  it('formats 0-1 range values to 3 decimal places when no unit', () => {
    expect(formatMetricValue(0.567, '')).toBe('0.567');
    expect(formatMetricValue(-0.5, '')).toBe('-0.500');
  });

  it('formats larger values with locale', () => {
    const result = formatMetricValue(1234, 'units');
    expect(result).toContain('1');
    expect(result).toContain('234');
  });
});

describe('trendDirection', () => {
  it('returns up when current > previous', () => {
    expect(trendDirection(1.5, 1.0)).toBe('up');
  });

  it('returns down when current < previous', () => {
    expect(trendDirection(0.5, 1.0)).toBe('down');
  });

  it('returns flat when delta < 0.001', () => {
    expect(trendDirection(1.0, 1.0)).toBe('flat');
    expect(trendDirection(1.0005, 1.0)).toBe('flat');
  });

  it('detects small but significant changes', () => {
    expect(trendDirection(1.002, 1.0)).toBe('up');
    expect(trendDirection(0.998, 1.0)).toBe('down');
  });
});
