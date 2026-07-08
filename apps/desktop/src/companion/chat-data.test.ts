import { describe, it, expect, vi, beforeEach } from 'vitest';

/* mock apiFetch 验 chatWithCompanion 的网络错自动重试（sidecar 崩溃重启换端口后，首次 POST 打死
 * 旧端口→TypeError；apiFetch 已失效缓存，重发取活端口成功）。 */
const fetchMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/bridge/http-client', () => ({
  apiFetch: fetchMock.fn,
  ApiHttpError: class ApiHttpError extends Error {},
  ApiNotConfiguredError: class ApiNotConfiguredError extends Error {},
}));

import { chatWithCompanion } from './chat-data';

beforeEach(() => { fetchMock.fn.mockReset(); });

describe('chatWithCompanion 网络错自动重试（sidecar 重连换端口）', () => {
  it('首次 TypeError（打死旧端口）→ 自动重试一次成功', async () => {
    fetchMock.fn
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce({ data: { reply: '互斥锁答', kind: 'knowledge_grounded', confidence: 0.7, groundedMemoryCount: 3 } });
    const res = await chatWithCompanion('详细讲讲互斥锁');
    expect(res.reply).toBe('互斥锁答');
    expect(fetchMock.fn).toHaveBeenCalledTimes(2); // 重试了一次
  });

  it('两次都 TypeError → 抛 TypeError（页面转「连不上本地引擎，再发一次」）', async () => {
    fetchMock.fn.mockRejectedValue(new TypeError('Load failed'));
    await expect(chatWithCompanion('hi')).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock.fn).toHaveBeenCalledTimes(2);
  });

  it('非网络错（业务错）不重试，原样抛', async () => {
    const bizErr = new Error('业务错');
    fetchMock.fn.mockRejectedValue(bizErr);
    await expect(chatWithCompanion('hi')).rejects.toBe(bizErr);
    expect(fetchMock.fn).toHaveBeenCalledTimes(1); // 不重试
  });

  it('成功 → 直接返回不重试', async () => {
    fetchMock.fn.mockResolvedValue({ data: { reply: 'ok', kind: 'self_intro', confidence: 0.6, groundedMemoryCount: 0 } });
    const res = await chatWithCompanion('你好');
    expect(res.reply).toBe('ok');
    expect(fetchMock.fn).toHaveBeenCalledTimes(1);
  });
});
