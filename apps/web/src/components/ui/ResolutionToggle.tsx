import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Resolution } from '../../types';

const OPTION_KEYS: ReadonlyArray<{ value: Resolution; i18nKey: string }> = [
  { value: 'year', i18nKey: 'resolution.year' },
  { value: '2y', i18nKey: 'resolution.twoYears' },
  { value: '5y', i18nKey: 'resolution.fiveYears' },
];

interface ResolutionToggleProps {
  value: Resolution;
  onChange: (v: Resolution) => void;
}

export function ResolutionToggle({ value, onChange }: ResolutionToggleProps) {
  const { t } = useTranslation();
  const groupRef = useRef<HTMLDivElement>(null);
  const options = useMemo(
    () => OPTION_KEYS.map((o) => ({ value: o.value, label: t(o.i18nKey) })),
    [t],
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const idx = OPTION_KEYS.findIndex(o => o.value === value);
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { next = (idx + 1) % OPTION_KEYS.length; }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { next = (idx - 1 + OPTION_KEYS.length) % OPTION_KEYS.length; }
    else return;
    e.preventDefault();
    onChange(OPTION_KEYS[next]!.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[next]?.focus();
  }, [value, onChange]);

  return (
    <div ref={groupRef} className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="radiogroup" aria-label={t('aria.timeResolution')} onKeyDown={handleKeyDown}>
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          onClick={() => onChange(opt.value)}
          aria-checked={value === opt.value}
          tabIndex={value === opt.value ? 0 : -1}
          className={`rounded-md px-3 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 ${
            value === opt.value
              ? 'bg-primary text-white'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
