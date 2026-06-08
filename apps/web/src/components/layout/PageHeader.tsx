import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 border-b border-border pb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            <span className="inline-block h-1.5 w-1.5 rounded-full mr-3 align-middle" style={{ background: 'var(--gradient-brand)', boxShadow: 'var(--glow-cyan)' }} aria-hidden="true" />
            {title}
          </h1>
          {subtitle && <p className="mt-1.5 text-sm text-text-secondary">{subtitle}</p>}
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
    </div>
  );
}
