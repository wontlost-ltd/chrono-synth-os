/**
 * 403 — forbidden / role-gated route.
 *
 * Used when a route requires admin and the current user is a viewer or
 * member. The wrapper components (AdminOnly) used to render an inline
 * EmptyState; we now route through this branded page for parity with
 * 404 / 500 surfaces.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function Forbidden() {
  const { t } = useTranslation();
  useDocumentTitle(t('errorPages.forbidden.documentTitle'));

  return (
    <main
      role="main"
      className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-6 py-16 text-center"
    >
      <div
        aria-hidden
        className="select-none text-[7rem] font-bold leading-none tracking-tight text-warning/30"
      >
        403
      </div>
      <h1 className="text-2xl font-semibold text-text-primary">
        {t('errorPages.forbidden.title')}
      </h1>
      <p className="max-w-md text-sm text-text-secondary">
        {t('errorPages.forbidden.body')}
      </p>
      <Link
        to="/dashboard"
        className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {t('errorPages.forbidden.backToDashboard')}
      </Link>
    </main>
  );
}
