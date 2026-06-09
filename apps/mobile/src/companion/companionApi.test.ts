/**
 * companionApi 回归（ADR-0046 Phase 2.3）：分页 query 构造 + clamp + schema 校验路径。
 * 通过 mock apiFetch 断言 fetchCompanionMemories 传给后端的 page/pageSize 已被收敛到合法范围
 * （Codex 审查 Minor：URLSearchParams 构造 + 上下限 clamp）。
 */

import { fetchCompanionMemories } from './companionApi';
import * as client from '../api/client';

/* 一个最小的合法 CompanionMemoryListV1 响应——satisfies schema.parse。 */
const EMPTY_LIST = {
  schemaVersion: 'companion-memory-list.v1' as const,
  items: [],
  pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
};

describe('fetchCompanionMemories 分页 query 构造', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest.spyOn(client, 'apiFetch').mockResolvedValue(EMPTY_LIST as never);
  });
  afterEach(() => spy.mockRestore());

  /** 解析本次调用 path 的 query，精确断言 page/pageSize（避免 toContain 子串误判）。 */
  function calledQuery(): URLSearchParams {
    const path = spy.mock.calls[0]![0] as string;
    return new URLSearchParams(path.slice(path.indexOf('?') + 1));
  }

  it('默认 page=1 pageSize=20', async () => {
    await fetchCompanionMemories();
    const q = calledQuery();
    expect(q.get('page')).toBe('1');
    expect(q.get('pageSize')).toBe('20');
  });

  it('正常分页透传', async () => {
    await fetchCompanionMemories(3, 50);
    const q = calledQuery();
    expect(q.get('page')).toBe('3');
    expect(q.get('pageSize')).toBe('50');
  });

  it('非法 page/pageSize（0/负）回退默认', async () => {
    await fetchCompanionMemories(0, -5);
    const q = calledQuery();
    expect(q.get('page')).toBe('1');
    expect(q.get('pageSize')).toBe('20');
  });

  it('NaN → 回退默认', async () => {
    await fetchCompanionMemories(Number.NaN, Number.NaN);
    const q = calledQuery();
    expect(q.get('page')).toBe('1');
    expect(q.get('pageSize')).toBe('20');
  });

  it('超大 pageSize 被 clamp 到上限 100', async () => {
    await fetchCompanionMemories(1, 100000);
    expect(calledQuery().get('pageSize')).toBe('100');
  });

  it('小数被取整', async () => {
    await fetchCompanionMemories(2.9, 19.9);
    const q = calledQuery();
    expect(q.get('page')).toBe('2');
    expect(q.get('pageSize')).toBe('19');
  });
});
