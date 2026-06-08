import { useTranslation } from 'react-i18next';

interface LogItem {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  title: string;
  detail?: string;
}

interface LogTimelineProps {
  items: LogItem[];
  loading?: boolean;
}

const LEVEL_STYLE: Record<string, { dot: string; text: string }> = {
  info:  { dot: 'bg-info',    text: 'text-info' },
  warn:  { dot: 'bg-paused',  text: 'text-paused' },
  error: { dot: 'bg-error',   text: 'text-error' },
};

export function LogTimeline({ items, loading }: LogTimelineProps) {
  const { t } = useTranslation();

  if (loading) {
    return <div className="animate-pulse space-y-4">{[1, 2, 3].map(i => <div key={i} className="h-10 rounded bg-border/50" />)}</div>;
  }

  if (!items.length) {
    return <p className="py-8 text-center text-sm text-text-secondary">{t('logTimeline.empty')}</p>;
  }

  return (
    <ol className="relative border-l border-border pl-6 space-y-4">
      {items.map(item => {
        const style = LEVEL_STYLE[item.level] ?? LEVEL_STYLE.info!;
        return (
          <li key={item.id} className="relative">
            <div className={`absolute -left-[1.56rem] top-1.5 h-2.5 w-2.5 rounded-full ${style.dot}`} />
            <time dateTime={item.ts} className="text-xs text-text-secondary">{new Date(item.ts).toLocaleString()}</time>
            <p className={`text-sm font-medium ${style.text}`}>{item.title}</p>
            {item.detail && <p className="mt-0.5 text-xs text-text-secondary">{item.detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}
