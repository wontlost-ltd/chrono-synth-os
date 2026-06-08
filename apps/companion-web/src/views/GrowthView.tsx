import type { JSX } from 'react';
import type { ExplorationDirectionV1, ExplorationIntensityV1 } from '@chrono/contracts';
import { fetchGrowth } from '../api.js';
import { useAsync } from '../useAsync.js';
import { StateBlock } from './StateBlock.js';

const INTENSITY_LABEL: Record<ExplorationIntensityV1, string> = {
  steady: '平稳',
  exploring: '正在探索',
  leaping: '大幅探索',
};

const DIRECTION_LABEL: Record<ExplorationDirectionV1['direction'], string> = {
  toward: '越来越看重',
  away: '逐渐放下',
  steady: '基本不变',
};

/**
 * 「成长」视图：把企业版的 persona drift 渲染成「你最近探索的方向」。
 * 这是 ADR-0046「同内核两外壳」的核心证明 —— 同一份 DriftReport，不再是「违规告警」。
 */
export function GrowthView(): JSX.Element {
  const growth = useAsync(fetchGrowth, []);
  if (growth.status !== 'ok' || !growth.data) {
    return <StateBlock status={growth.status} error={growth.error} authError={growth.authError} />;
  }
  const { hasBaseline, overallIntensity, directions } = growth.data;

  if (!hasBaseline) {
    return (
      <section className="view">
        <section className="card card--empty">
          <h2 className="card__title">还在认识你</h2>
          <p className="muted">我需要再陪你一段时间，才能看出自己在往哪个方向成长。</p>
        </section>
      </section>
    );
  }

  return (
    <section className="view">
      <section className="card">
        <h2 className="card__title">最近的我</h2>
        <p className="intensity">
          整体上，我<strong>{INTENSITY_LABEL[overallIntensity]}</strong>。
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">你最近探索的方向</h2>
        {directions.length === 0 ? (
          <p className="muted">这段时间我很稳定，没有明显变化。</p>
        ) : (
          <ul className="directions">
            {directions.map((d) => (
              <li key={d.valueId} className="direction">
                <span className="direction__label">{d.label}</span>
                <span className="direction__desc">
                  {DIRECTION_LABEL[d.direction]} · {INTENSITY_LABEL[d.intensity]}
                </span>
                <span className="direction__bar" aria-hidden="true">
                  <span className="direction__fill" style={{ width: `${Math.round(d.magnitude * 100)}%` }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
