import { useRef, useCallback } from 'react';

interface RadioGroupOption<T extends string> {
  value: T;
  label: string;
}

interface RadioGroupProps<T extends string> {
  options: ReadonlyArray<RadioGroupOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}

export function RadioGroup<T extends string>({ options, value, onChange, label, className = '' }: RadioGroupProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const idx = options.findIndex(o => o.value === value);
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + options.length) % options.length;
    else return;
    e.preventDefault();
    const opt = options[next];
    if (opt) onChange(opt.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[next]?.focus();
  }, [options, value, onChange]);

  return (
    <div ref={groupRef} className={`flex flex-wrap gap-2 ${className}`} role="radiogroup" aria-label={label} onKeyDown={handleKeyDown}>
      {options.map(opt => (
        <button
          type="button"
          role="radio"
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-checked={value === opt.value}
          tabIndex={value === opt.value ? 0 : -1}
          className={`rounded-lg px-3 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/50 ${
            value === opt.value ? 'bg-primary text-white' : 'bg-surface border border-border text-text-secondary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
