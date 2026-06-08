/**
 * 404 — page not found.
 *
 * Brand-correct error space (P3.9): big illustrative number, helpful copy,
 * and a "try these" set of recommended routes the user can click into.
 * Lives at the route catch-all `*`; also reachable via direct navigation.
 *
 * The recommended routes are a curated subset (dashboard / personas /
 * simulations / settings) — not a full nav dump, because users hitting
 * 404 already saw the sidebar.
 */

import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const SUGGESTIONS: ReadonlyArray<{ to: string; labelKey: string }> = [
  { to: '/dashboard', labelKey: 'errorPages.suggestions.dashboard' },
  { to: '/personas', labelKey: 'errorPages.suggestions.personas' },
  { to: '/simulations', labelKey: 'errorPages.suggestions.simulations' },
  { to: '/settings', labelKey: 'errorPages.suggestions.settings' },
];

export function NotFound() {
  const { t } = useTranslation();
  const location = useLocation();
  useDocumentTitle(t('errorPages.notFound.documentTitle'));

  return (
    <main
      role="main"
      className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-6 py-16 text-center"
    >
      <div
        aria-hidden
        className="select-none text-[7rem] font-bold leading-none tracking-tight text-primary/15"
      >
        404
      </div>
      <h1 className="text-2xl font-semibold text-text-primary">
        {t('errorPages.notFound.title')}
      </h1>
      <p className="max-w-md text-sm text-text-secondary">
        {t('errorPages.notFound.body')}
      </p>
      <p className="font-mono text-xs text-text-secondary/80">{location.pathname}</p>
      <section aria-labelledby="not-found-suggestions" className="mt-2">
        <h2 id="not-found-suggestions" className="text-xs uppercase tracking-wider text-text-secondary">
          {t('errorPages.suggestions.heading')}
        </h2>
        <ul className="mt-3 flex flex-wrap items-center justify-center gap-2 text-sm">
          {SUGGESTIONS.map((s) => (
            <li key={s.to}>
              <Link
                to={s.to}
                className="rounded-full border border-border bg-surface px-3 py-1.5 text-text-primary hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {t(s.labelKey)}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
