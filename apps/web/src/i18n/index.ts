/**
 * i18n 初始化
 * 支持 zh-CN / en-US，自动检测浏览器语言
 * 语言资源通过动态 import 按需加载
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

const LOCALE_LOADERS: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  'zh-CN': () => import('./locales/zh-CN.json'),
  'en-US': () => import('./locales/en-US.json'),
};

/** 动态加载并注册语言资源包 */
async function loadLocale(lng: string): Promise<void> {
  if (i18n.hasResourceBundle(lng, 'translation')) return;
  const loader = LOCALE_LOADERS[lng];
  if (!loader) return;
  const mod = await loader();
  i18n.addResourceBundle(lng, 'translation', mod.default, true, true);
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {},
    supportedLngs: ['zh-CN', 'en-US'],
    fallbackLng: {
      'en': ['en-US'],
      'en-US': ['en-US'],
      'en-GB': ['en-US'],
      'zh': ['zh-CN'],
      'zh-TW': ['zh-CN'],
      'default': ['zh-CN'],
    },
    nonExplicitSupportedLngs: false,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'chrono-lang',
      caches: ['localStorage'],
    },
    partialBundledLanguages: true,
    /* react-i18next 17 keeps useSuspense=true as the default; we explicitly
     * disable it because our app does eager resource loading right after
     * init (see initLoads below), and Suspense fallbacks would briefly
     * unmount the AppShell while the bundle deserialises. */
    react: { useSuspense: false },
  });

/** 初始加载检测到的语言和回退语言 */
const detected = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN';
const initLoads = [loadLocale(detected)];
if (detected !== 'zh-CN') initLoads.push(loadLocale('zh-CN'));
if (detected !== 'en-US') initLoads.push(loadLocale('en-US'));
Promise.all(initLoads).catch(() => { /* 静默降级 */ });

/** 切换语言时按需加载资源 */
i18n.on('languageChanged', (lng: string) => {
  loadLocale(lng).catch(() => { /* 静默降级 */ });
});

function syncHtmlLang(lang: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
}

i18n.on('languageChanged', syncHtmlLang);
syncHtmlLang(i18n.resolvedLanguage ?? i18n.language);

export default i18n;
