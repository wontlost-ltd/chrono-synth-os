import { useCallback, useState, type JSX } from 'react';
import type { CompanionNudgeV1 } from '@chrono/contracts';
import { fetchNudges, markNudgeRead } from '../api.js';
import { useAsync } from '../useAsync.js';
import { useNudgeStream } from '../useNudgeStream.js';
import { StateBlock } from './StateBlock.js';

/** 各 nudge 类别的中文标签（供分组/图标渲染）。 */
const KIND_LABEL: Record<string, string> = {
  memory: '回想',
  narrative: '自我',
  growth: '成长',
  general: '想说',
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? '想说';
}

/** 把 epoch ms 渲染成相对友好时间（确定性，本地化由浏览器 toLocaleString 负责）。 */
function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

/**
 * 「TA 主动跟我说的」视图（ADR-0054）：数字人据自己内部状态变化主动发起的消息。
 * 从「我问 TA 答」到「TA 会主动找我」—— 这是主动性架构对用户可见的落点。
 */
export function NudgesView(): JSX.Element {
  /* 标记已读后 bump reloadKey 触发 useAsync 重取（列表 + 未读态刷新）。 */
  const [reloadKey, setReloadKey] = useState(0);
  const nudges = useAsync(() => fetchNudges('all'), [reloadKey]);

  /* ADR-0054 Phase 6：订阅 companion:nudge-created SSE——数字人新主动开口时实时刷新列表。 */
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  useNudgeStream(refresh);

  const onRead = useCallback(async (id: string) => {
    try {
      await markNudgeRead(id);
    } finally {
      /* 无论成功/幂等都刷新（mark-read 对已读幂等 200）。 */
      setReloadKey((k) => k + 1);
    }
  }, []);

  if (nudges.status !== 'ok' || !nudges.data) {
    return <StateBlock status={nudges.status} error={nudges.error} authError={nudges.authError} />;
  }

  const items = nudges.data.items;
  if (items.length === 0) {
    return (
      <section className="view">
        <section className="card card--empty">
          <h2 className="card__title">还没有主动消息</h2>
          <p className="muted">等我有了新的想法或成长，会主动来找你说说。</p>
        </section>
      </section>
    );
  }

  const unreadCount = items.filter((n) => n.status === 'unread').length;

  return (
    <section className="view">
      <section className="card">
        <h2 className="card__title">TA 主动跟我说的</h2>
        <p className="muted">
          {unreadCount > 0 ? `有 ${unreadCount} 条还没读` : '都读过了'}
        </p>
      </section>

      <ul className="nudges">
        {items.map((n: CompanionNudgeV1) => (
          <li
            key={n.id}
            className={n.status === 'unread' ? 'nudge nudge--unread' : 'nudge'}
          >
            <div className="nudge__head">
              <span className="nudge__kind">{kindLabel(n.kind)}</span>
              <span className="nudge__time">{formatTime(n.createdAt)}</span>
            </div>
            <p className="nudge__body">{n.body}</p>
            {n.status === 'unread' && (
              <button
                type="button"
                className="nudge__read-btn"
                onClick={() => { void onRead(n.id); }}
              >
                标记已读
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
