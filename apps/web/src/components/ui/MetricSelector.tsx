import { useTranslation } from 'react-i18next';
import type { MetricKey, MetricMeta } from '../../types';

const DEFAULT_METRIC_KEYS: ReadonlyArray<{ key: MetricKey; i18nKey: string }> = [
  { key: 'wealth', i18nKey: 'metric.wealth' },
  { key: 'healthIndex', i18nKey: 'metric.healthIndex' },
  { key: 'overallScore', i18nKey: 'metric.overallScore' },
  { key: 'emotionalState.valence', i18nKey: 'metric.emotionalValence' },
  { key: 'emotionalState.stress', i18nKey: 'metric.emotionalStress' },
  { key: 'emotionalState.fulfillment', i18nKey: 'metric.emotionalFulfillment' },
  { key: 'emotionalState.regret', i18nKey: 'metric.emotionalRegret' },
  { key: 'familyState.spouseSecurity', i18nKey: 'metric.spouseSecurity' },
  { key: 'familyState.childCost', i18nKey: 'metric.childCost' },
  { key: 'familyState.familyPressure', i18nKey: 'metric.familyPressure' },
];

interface MetricSelectorProps {
  selected: MetricKey[];
  onChange: (keys: MetricKey[]) => void;
  metricMeta?: MetricMeta[];
}

export function MetricSelector({ selected, onChange, metricMeta }: MetricSelectorProps) {
  const { t } = useTranslation();
  const options: Array<{ key: MetricKey; label: string }> =
    metricMeta?.map((m) => ({ key: m.key, label: m.label })) ??
    DEFAULT_METRIC_KEYS.map((m) => ({ key: m.key, label: t(m.i18nKey) }));

  function toggle(key: MetricKey) {
    if (selected.includes(key)) {
      onChange(selected.filter(k => k !== key));
    } else {
      onChange([...selected, key]);
    }
  }

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('aria.metricSelection')}>
      {options.map(opt => (
        <button
          key={opt.key}
          type="button"
          onClick={() => toggle(opt.key)}
          aria-pressed={selected.includes(opt.key)}
          className={`rounded-full px-3 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 ${
            selected.includes(opt.key)
              ? 'bg-primary text-white'
              : 'bg-surface border border-border text-text-secondary hover:border-primary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
