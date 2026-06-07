import { fetchMe } from '../api.js';
import { useAsync } from '../useAsync.js';
import { StateBlock } from './StateBlock.js';

/** 「我的数字人」主页：叙事 + 最看重的价值 + 最近记忆。 */
export function HomeView(): JSX.Element {
  const me = useAsync(fetchMe, []);
  if (me.status !== 'ok' || !me.data) {
    return <StateBlock status={me.status} error={me.error} authError={me.authError} />;
  }
  const { narrative, topValues, recentMemories, valueCount, memoryCount } = me.data;

  return (
    <section className="view">
      <section className="card">
        <h2 className="card__title">此刻的我</h2>
        <p className="narrative">{narrative.trim() || '我还在认识这个世界，和你多聊聊吧。'}</p>
        <p className="overview">
          <span>{valueCount} 个价值</span>
          <span>·</span>
          <span>{memoryCount} 段记忆</span>
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">我最看重的</h2>
        {topValues.length === 0 ? (
          <p className="muted">还没有形成价值取向。</p>
        ) : (
          <ul className="values">
            {topValues.map((v) => (
              <li key={v.id} className="value">
                <span className="value__label">{v.label}</span>
                <span className="value__bar" aria-hidden="true">
                  <span className="value__fill" style={{ width: `${Math.round(v.weight * 100)}%` }} />
                </span>
                <span className="value__weight">{Math.round(v.weight * 100)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">最近记得的</h2>
        {recentMemories.length === 0 ? (
          <p className="muted">还没有记忆。</p>
        ) : (
          <ul className="memories">
            {recentMemories.map((m) => (
              <li key={m.id} className="memory">
                <span className={m.valence >= 0 ? 'memory__dot memory__dot--pos' : 'memory__dot memory__dot--neg'} aria-hidden="true" />
                <span className="memory__content">{m.content}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
