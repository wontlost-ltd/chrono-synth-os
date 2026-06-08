import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export interface Crumb {
  label: string;
  to?: string;
}

interface BreadcrumbsProps {
  items: Crumb[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('aria.breadcrumb')} className="mb-4 text-sm text-text-secondary">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((crumb, i) => (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true">/</span>}
            {crumb.to ? (
              <Link to={crumb.to} className="hover:text-primary hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-text-primary font-medium">
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
