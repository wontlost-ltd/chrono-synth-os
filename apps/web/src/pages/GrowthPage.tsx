/**
 * GrowthPage — visual capability ladder + current standing.
 *
 * Linked from the user menu and from `/dashboard` once available. The page
 * itself is content-only; level transitions trigger LevelUpCelebration which
 * is mounted globally in AppShell.
 */

import { useTranslation } from 'react-i18next';
import { GrowthTree } from '../features/growth/GrowthTree';
import { useUserLevel } from '../features/growth/useUserLevel';

export default function GrowthPage() {
  const { t } = useTranslation();
  const { level, daysOfUse } = useUserLevel();

  return (
    <article className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-text-primary">{t('growth.page.title')}</h1>
        <p className="mt-1 text-text-secondary">
          {t('growth.page.subtitle', { level, daysOfUse })}
        </p>
      </header>

      <section>
        <GrowthTree />
      </section>
    </article>
  );
}
