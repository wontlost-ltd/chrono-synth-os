import { useEffect, useState } from 'react';
import { ApiAuthError } from './api.js';

export interface AsyncState<T> {
  readonly status: 'loading' | 'ok' | 'error';
  readonly data?: T;
  readonly error?: string;
  readonly authError?: boolean;
}

/**
 * 极简一次性取数 hook（本切片不引入 TanStack Query —— chrono-synth-web 才是
 * query 客户端的事实来源；companion 扩展到列表/缓存时再对齐其约定）。
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    loader()
      .then((data) => { if (alive) setState({ status: 'ok', data }); })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiAuthError) {
          setState({ status: 'error', error: err.message, authError: true });
        } else {
          setState({ status: 'error', error: err instanceof Error ? err.message : '未知错误' });
        }
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
