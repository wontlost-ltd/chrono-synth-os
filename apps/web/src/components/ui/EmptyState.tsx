/**
 * EmptyState — list / detail empty surfaces.
 *
 * Two API surfaces, both supported simultaneously:
 *
 *  1. Legacy: <EmptyState message="..." action={...} variant="error|empty" />
 *     All 28 existing callsites use this shape; they keep working unchanged.
 *
 *  2. P1.7.2 structured: <EmptyState
 *        illustration="personas"
 *        title="..." message="..."
 *        primaryAction={{ label, onClick|to }}
 *        secondaryAction={{ label, href }}
 *     />
 *     Adds an inline SVG illustration, an optional headline, and a
 *     dark/text CTA pair styled consistently with the system palette.
 *
 * The illustrations are simple line glyphs in `currentColor`; they pick up
 * the surrounding text color so dark mode + theme switches work for free.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export type EmptyStateIllustration =
  | 'inbox'
  | 'personas'
  | 'memories'
  | 'tools'
  | 'safety'
  | 'confirmations'
  | 'search'
  | 'error';

export interface EmptyStateAction {
  label: string;
  /** Internal route — uses react-router Link for SPA nav */
  to?: string;
  /** External link — uses anchor with target=_blank rel=noopener */
  href?: string;
  /** Imperative action (modal open, mutation) */
  onClick?: () => void;
}

interface EmptyStateProps {
  message: string;
  /** Optional headline above the message; new in P1.7.2 */
  title?: string;
  /** Inline SVG glyph keyed by intent; new in P1.7.2 */
  illustration?: EmptyStateIllustration;
  /** Dark CTA — primary call to action */
  primaryAction?: EmptyStateAction;
  /** Quiet CTA — usually a "learn more" link */
  secondaryAction?: EmptyStateAction;
  /** Legacy slot — still honoured. Newer callsites use primaryAction. */
  action?: ReactNode;
  variant?: 'empty' | 'error';
}

export function EmptyState({
  message,
  title,
  illustration,
  primaryAction,
  secondaryAction,
  action,
  variant = 'empty',
}: EmptyStateProps) {
  const isError = variant === 'error';
  const showIllustration = illustration ?? (isError ? 'error' : null);
  return (
    <div
      className="relative flex flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-surface-elevated px-6 py-16 text-center"
      role={isError ? 'alert' : 'status'}
    >
      {/* Ambient gradient glow behind the illustration */}
      {!isError && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-8 left-1/2 h-24 w-24 -translate-x-1/2 rounded-full opacity-50"
          style={{ background: 'var(--gradient-brand-soft)', filter: 'blur(24px)' }}
        />
      )}
      {showIllustration && (
        /* #818CF8 = indigo 品牌插画着色，与 EnterpriseConsole 的 indigo accent（同色值）同源；
         * 仅 2 处装饰性使用，未升级为全局语义 token（design-tokens 无 illustration 类目，
         * 为一个插画色扩 3 套主题的类型化契约+codegen 不成比例）。非主题化但语义稳定。 */
        <Illustration
          name={showIllustration}
          className={`relative ${isError ? 'text-warning' : 'text-[#818CF8]'}`}
        />
      )}
      {title && (
        <h2 className="mt-4 text-base font-semibold text-text-primary">{title}</h2>
      )}
      <p className={`${title ? 'mt-1' : 'mt-4'} max-w-md text-sm ${isError ? 'text-warning' : 'text-text-secondary'}`}>
        {message}
      </p>
      {(primaryAction || secondaryAction || action) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {primaryAction && <ActionButton action={primaryAction} variant="primary" />}
          {secondaryAction && <ActionButton action={secondaryAction} variant="secondary" />}
          {action}
        </div>
      )}
    </div>
  );
}

function ActionButton({ action, variant }: { action: EmptyStateAction; variant: 'primary' | 'secondary' }) {
  const baseClass =
    variant === 'primary'
      ? 'btn-brand rounded-lg px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
      : 'text-sm text-text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

  if (action.to) {
    return (
      <Link to={action.to} className={baseClass}>
        {action.label}
      </Link>
    );
  }
  if (action.href) {
    return (
      <a href={action.href} target="_blank" rel="noopener noreferrer" className={baseClass}>
        {action.label}
      </a>
    );
  }
  return (
    <button type="button" className={baseClass} onClick={action.onClick}>
      {action.label}
    </button>
  );
}

/** Inline SVG glyphs — currentColor + 1.5px stroke, ~64 px viewBox.
 *  Each glyph is decorative (aria-hidden); the surrounding role/text carries
 *  the semantics for screen readers. */
function Illustration({ name, className }: { name: EmptyStateIllustration; className: string }) {
  const props = {
    width: 56,
    height: 56,
    viewBox: '0 0 64 64',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  };
  switch (name) {
    case 'personas':
      return (
        <svg {...props}>
          <circle cx="22" cy="22" r="6" />
          <circle cx="42" cy="22" r="6" />
          <path d="M10 50c0-7 6-12 12-12s12 5 12 12" />
          <path d="M30 50c0-7 6-12 12-12s12 5 12 12" />
        </svg>
      );
    case 'memories':
      return (
        <svg {...props}>
          <rect x="14" y="14" width="36" height="36" rx="4" />
          <path d="M22 24h20M22 32h20M22 40h12" />
        </svg>
      );
    case 'tools':
      return (
        <svg {...props}>
          <path d="M40 16l8 8-22 22-8-8z" />
          <path d="M16 50l4-4M44 12l4 4" />
        </svg>
      );
    case 'safety':
      return (
        <svg {...props}>
          <path d="M32 10l18 6v12c0 12-7 22-18 26-11-4-18-14-18-26V16z" />
          <path d="M24 32l6 6 12-12" />
        </svg>
      );
    case 'confirmations':
      return (
        <svg {...props}>
          <circle cx="32" cy="32" r="20" />
          <path d="M32 20v14l8 4" />
        </svg>
      );
    case 'search':
      return (
        <svg {...props}>
          <circle cx="28" cy="28" r="14" />
          <path d="M40 40l10 10" />
        </svg>
      );
    case 'error':
      return (
        <svg {...props}>
          <circle cx="32" cy="32" r="20" />
          <path d="M32 20v16M32 42v2" />
        </svg>
      );
    case 'inbox':
    default:
      return (
        <svg {...props}>
          <path d="M12 36l8-22h24l8 22M12 36v12h40V36M12 36h12l4 6h8l4-6h12" />
        </svg>
      );
  }
}
