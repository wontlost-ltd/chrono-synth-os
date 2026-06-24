import type { JSX } from 'react';
import { fetchMe } from '../api.js';
import { useAsync } from '../useAsync.js';
import { StateBlock } from './StateBlock.js';
import { EdgeRuntimeBadge } from './EdgeRuntimeBadge.js';

/** 「我的数字人」主页：叙事 + 最看重的价值 + 最近记忆。 */
export function HomeView(): JSX.Element {
  const me = useAsync(fetchMe, []);
  if (me.status !== 'ok' || !me.data) {
    return <StateBlock status={me.status} error={me.error} authError={me.authError} />;
  }
  const { narrative, topValues, recentMemories, valueCount, memoryCount } = me.data;
  /* 拟人化形象：确定性渐变「光球」头像——以叙事文本派生稳定色相，无需后端头像字段，
   * 同一数字人每次同一形象（narrative 变了形象才微动，呼应「在成长」）。 */
  const hue = avatarHue(narrative);
  const learnedCount = valueCount + memoryCount; // 「学到的关于你的事」= 价值+记忆

  return (
    <section className="view">
      <EdgeRuntimeBadge />
      <section className="card card--hero">
        <span
          className="avatar"
          aria-hidden="true"
          style={{ background: `radial-gradient(circle at 32% 28%, hsl(${hue} 70% 62%), hsl(${(hue + 38) % 360} 64% 40%))` }}
        />
        <div className="hero__body">
          <h2 className="card__title">此刻的我</h2>
          <p className="narrative">{narrative.trim() || '我还在认识这个世界，和你多聊聊吧。'}</p>
          <p className="hero__progress">
            {learnedCount > 0
              ? <>我已经学到了 <strong>{learnedCount}</strong> 件关于你的事</>
              : <>我刚认识你，多和我聊聊吧</>}
          </p>
          <p className="overview">
            <span>{valueCount} 个价值</span>
            <span>·</span>
            <span>{memoryCount} 段记忆</span>
          </p>
        </div>
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

/** 由叙事文本确定性派生头像色相。FNV-1a 简化哈希→**强制映射到暖色区间 12-52°**（琥珀/珊瑚/金），
 * 保证「温暖伙伴」品牌一致（纯 %360 会大概率落到绿/青/紫冷调，与暖色目标冲突）。同一叙事同一色相可复现。 */
function avatarHue(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 12 + (Math.abs(h) % 41); // 12-52°：暖琥珀↔珊瑚区间
}
