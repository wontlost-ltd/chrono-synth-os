import '@testing-library/jest-dom/vitest';
import { beforeAll } from 'vitest';
import i18n from '../i18n';
import zhCN from '../i18n/locales/zh-CN.json';

beforeAll(async () => {
  if (!i18n.hasResourceBundle('zh-CN', 'translation')) {
    i18n.addResourceBundle('zh-CN', 'translation', zhCN, true, true);
  }
  await i18n.changeLanguage('zh-CN');
});
