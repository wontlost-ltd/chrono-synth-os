import { useState, useRef, useCallback, type ReactNode } from 'react';

interface TabItem {
  id: string;
  label: ReactNode;
  disabled?: boolean;
}

interface TabsProps {
  value: string;
  onChange: (v: string) => void;
  items: TabItem[];
  renderPanel: (id: string) => ReactNode;
}

export function Tabs({ value, onChange, items, renderPanel }: TabsProps) {
  const [visited, setVisited] = useState<Set<string>>(new Set([value]));
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const enabledItems = items.filter(i => !i.disabled);
    const currentIdx = enabledItems.findIndex(i => i.id === value);
    let nextIdx = currentIdx;

    if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % enabledItems.length;
    else if (e.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + enabledItems.length) % enabledItems.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = enabledItems.length - 1;
    else return;

    e.preventDefault();
    const next = enabledItems[nextIdx]!;
    onChange(next.id);
    setVisited(prev => new Set(prev).add(next.id));
    (tabListRef.current?.querySelector(`[data-tab-id="${next.id}"]`) as HTMLElement)?.focus();
  }, [items, value, onChange]);

  const selectTab = (id: string) => {
    onChange(id);
    setVisited(prev => new Set(prev).add(id));
  };

  return (
    <div>
      <div
        ref={tabListRef}
        role="tablist"
        className="flex gap-0 overflow-x-auto border-b border-border"
        onKeyDown={handleKeyDown}
      >
        {items.map(item => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              id={`tab-${item.id}`}
              role="tab"
              data-tab-id={item.id}
              aria-selected={selected}
              aria-controls={`tabpanel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => selectTab(item.id)}
              className={`relative whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors
                ${selected ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'}
                ${item.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              {item.label}
              {selected && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-3 -bottom-px h-[2px] rounded-t"
                  style={{ background: 'var(--gradient-brand)', boxShadow: '0 0 8px rgba(99, 102, 241, 0.6)' }}
                />
              )}
            </button>
          );
        })}
      </div>
      {items.map(item => {
        if (!visited.has(item.id)) return null;
        return (
          <div
            key={item.id}
            id={`tabpanel-${item.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${item.id}`}
            hidden={item.id !== value}
            className="pt-4"
          >
            {renderPanel(item.id)}
          </div>
        );
      })}
    </div>
  );
}
