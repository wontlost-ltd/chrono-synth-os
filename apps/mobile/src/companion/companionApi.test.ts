/**
 * companionApi 回归（ADR-0046 Phase 2.3）：分页 query 构造 + clamp + schema 校验路径。
 * 通过 mock apiFetch 断言 fetchCompanionMemories 传给后端的 page/pageSize 已被收敛到合法范围
 * （Codex 审查 Minor：URLSearchParams 构造 + 上下限 clamp）。
 */

import { fetchCompanionMemories, companionPerceive, companionChat } from './companionApi';
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

describe('companionPerceive POST 请求形状 + 响应校验', () => {
  /* apiFetch 已 unwrap {data}，故 mock 直接返回 unwrap 后的 result。 */
  const OK_RESULT = {
    schemaVersion: 'companion-perceive-result.v1' as const,
    perceivedMemories: [{ id: 'mem_1', content: '我听到：今天开会很累', valence: -0.3, salience: 0.6 }],
    perceivedBy: 'teacher' as const,
    growthCandidateCount: 1,
    pendingApprovalCount: 1,
  };

  let spy: jest.SpyInstance;
  beforeEach(() => { spy = jest.spyOn(client, 'apiFetch').mockResolvedValue(OK_RESULT as never); });
  afterEach(() => spy.mockRestore());

  it('POST /companion/me/perceive，body 是 {modality, representation} JSON', async () => {
    await companionPerceive({ modality: 'audio', representation: '今天开会很累。' });
    const [path, init] = spy.mock.calls[0]!;
    expect(path).toBe('/api/v1/companion/me/perceive');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ modality: 'audio', representation: '今天开会很累。' });
  });

  it('返回经 schema 校验的结果（含待审批数）', async () => {
    const res = await companionPerceive({ modality: 'audio', representation: 'x' });
    expect(res.perceivedMemories).toHaveLength(1);
    expect(res.perceivedMemories[0]!.content).toBe('我听到：今天开会很累');
    expect(res.pendingApprovalCount).toBe(1);
  });

  it('响应不符合契约（漂移）→ schema.parse 抛错（端到端类型同源守卫）', async () => {
    spy.mockResolvedValue({ schemaVersion: 'wrong', perceivedMemories: 'not-array' } as never);
    await expect(companionPerceive({ modality: 'audio', representation: 'x' })).rejects.toThrow();
  });
});

describe('companionChat POST 请求形状 + 响应校验', () => {
  const OK_RESULT = {
    schemaVersion: 'companion-chat-result.v1' as const,
    reply: '我记得你喜欢清晨写代码。',
    kind: 'knowledge_grounded' as const,
    confidence: 0.5,
    groundedMemoryCount: 2,
  };
  let spy: jest.SpyInstance;
  beforeEach(() => { spy = jest.spyOn(client, 'apiFetch').mockResolvedValue(OK_RESULT as never); });
  afterEach(() => spy.mockRestore());

  it('POST /companion/me/chat，body 是 {message} JSON', async () => {
    await companionChat('你好');
    const [path, init] = spy.mock.calls[0]!;
    expect(path).toBe('/api/v1/companion/me/chat');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ message: '你好' });
  });

  it('返回经 schema 校验的回应（含 kind/confidence/grounded 数）', async () => {
    const res = await companionChat('你好');
    expect(res.reply).toBe('我记得你喜欢清晨写代码。');
    expect(res.kind).toBe('knowledge_grounded');
    expect(res.groundedMemoryCount).toBe(2);
  });

  it('响应漂移 → schema.parse 抛错', async () => {
    spy.mockResolvedValue({ schemaVersion: 'wrong', reply: 123 } as never);
    await expect(companionChat('x')).rejects.toThrow();
  });
});
