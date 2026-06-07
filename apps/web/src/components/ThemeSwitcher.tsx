/**
 * ThemeSwitcher — dropdown for the four supported choices
 * (system / light / dark / high-contrast). Renders nothing during SSR.
 *
 * Mounted in the AppShell topbar on the user-settings menu;
 * Settings page surfaces a larger choice grid using the same hook.
 */

import { useTranslation } from 'react-i18next';
import { useThemeChoice, type ThemeChoice } from '../lib/theme';

const CHOICES: ReadonlyArray<{ value: ThemeChoice; labelKey: string }> = [
  { value: 'system', labelKey: 'theme.choices.system' },
  { value: 'light', labelKey: 'theme.choices.light' },
  { value: 'dark', labelKey: 'theme.choices.dark' },
  { value: 'high-contrast', labelKey: 'theme.choices.highContrast' },
];

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const [choice, setChoice] = useThemeChoice();

  return (
    <label className="flex items-center gap-2 text-xs text-text-secondary">
      <span>{t('theme.label')}</span>
      <select
        className="rounded border border-border bg-surface px-2 py-1 text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        value={choice}
        onChange={(e) => setChoice(e.target.value as ThemeChoice)}
        aria-label={t('theme.label')}
      >
        {CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {t(c.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}
