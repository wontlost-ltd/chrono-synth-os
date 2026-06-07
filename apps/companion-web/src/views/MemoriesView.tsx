import { useCallback, useEffect, useState } from 'react';
import type { CompanionMemoryV1 } from '@chrono/contracts';
import { fetchMemories, ApiAuthError } from '../api.js';

const PAGE_SIZE = 20;

type Status = 'loading' | 'ok' | 'error';

/** 「我的记忆」：分页浏览全部记忆，支持「加载更多」累积。 */
export function MemoriesView(): JSX.Element {
  const [items, setItems] = useState<CompanionMemoryV1[]>([]);
  const [page, setPage] = useState(0);          // 已加载到第几页（0=尚未加载）
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(async (next: number) => {
    try {
      if (next === 1) setStatus('loading'); else setLoadingMore(true);
      const res = await fetchMemories(next, PAGE_SIZE);
      setItems((prev) => (next === 1 ? res.items : [...prev, ...res.items]));
      setPage(next);
      setTotalPages(res.pagination.totalPages);
      setTotal(res.pagination.total);
      setStatus('ok');
    } catch (err) {
      if (err instanceof ApiAuthError) {
        /* 鉴权失效：App 的会话订阅会切回登录页，这里只标错避免卡 loading。 */
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : '未知错误');
      }
      setStatus('error');
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { void loadPage(1); }, [loadPage]);

  if (status === 'loading') return <div className="state state--loading">加载中…</div>;
  if (status === 'error') return <div className="state state--error">出错了：{error ?? '未知错误'}</div>;

  const hasMore = page < totalPages;

  return (
    <section className="view">
      <section className="card">
        <h2 className="card__title">我的记忆 · {total}</h2>
        {items.length === 0 ? (
          <p className="muted">还没有记忆。和我多聊聊吧。</p>
        ) : (
          <ul className="memories">
            {items.map((m) => (
              <li key={m.id} className="memory memory--row">
                <span className={m.valence >= 0 ? 'memory__dot memory__dot--pos' : 'memory__dot memory__dot--neg'} aria-hidden="true" />
                <span className="memory__content">{m.content}</span>
                <span className="memory__kind">{m.kind}</span>
              </li>
            ))}
          </ul>
        )}
        {hasMore && (
          <button
            className="loadmore" type="button" disabled={loadingMore}
            onClick={() => void loadPage(page + 1)}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        )}
      </section>
    </section>
  );
}
