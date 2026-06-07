import { useTranslation } from 'react-i18next';

// i18n-allow-cjk: 语言切换器自显语言名必须保持原文，使任何语言下用户都能识别
const LANGUAGES = [
  { code: 'zh-CN', label: '中文' }, // i18n-allow-cjk: language self-name
  { code: 'en-US', label: 'English' },
] as const;

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  return (
    <select
      value={i18n.resolvedLanguage ?? i18n.language}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      className="rounded border border-border bg-surface px-2 py-1 text-xs text-text-secondary"
      aria-label={t('common.language')}
    >
      {LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.label}
        </option>
      ))}
    </select>
  );
}
