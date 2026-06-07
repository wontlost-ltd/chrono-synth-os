import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useSse } from './sse';

const mockFetch = vi.fn();
const mockGetSession = vi.fn();
const mockGetCsrfToken = vi.fn();

vi.stubGlobal('fetch', mockFetch);

vi.mock('../../config', () => ({ API_BASE_URL: 'http://test-api' }));
vi.mock('../../store/session', () => ({
  getSession: () => mockGetSession(),
}));
vi.mock('../../lib/csrf', () => ({
  getCsrfToken: () => mockGetCsrfToken(),
}));

function createSseResponse(...chunks: string[]) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockGetSession.mockReturnValue({ accessToken: 'token-123', apiKey: '', tenantId: 'tenant-1', mode: 'demo', user: null });
  mockGetCsrfToken.mockReturnValue('csrf-token');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSse', () => {
  it('connects to the SSE stream endpoint and emits parsed messages', async () => {
    mockFetch.mockResolvedValueOnce(
      createSseResponse('id: 7\ndata: {"status":"ok"}\n\n'),
    );
    const onMessage = vi.fn();

    const { unmount } = renderHook(() => useSse('system', onMessage));

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith({ status: 'ok' }));
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-api/api/v1/events/stream?channel=system',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
          Authorization: 'Bearer token-123',
          'X-CSRF-Token': 'csrf-token',
        }),
      }),
    );

    unmount();
  });

  it('reconnects after EOF and resumes from the last event id', async () => {
    mockFetch
      .mockResolvedValueOnce(createSseResponse('id: 42\ndata: {"phase":"first"}\n\n'))
      .mockResolvedValueOnce(createSseResponse('data: {"phase":"second"}\n\n'));

    const onMessage = vi.fn();
    const { unmount } = renderHook(() => useSse('system', onMessage));

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith({ phase: 'first' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(mockFetch.mock.calls[1]?.[0]).toBe('http://test-api/api/v1/events/stream?channel=system&sinceSeq=42');
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith({ phase: 'second' }));

    unmount();
  }, 8000);
});
