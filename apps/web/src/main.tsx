import { initSentry } from './lib/sentry';
initSentry();

import { reportWebVitals } from './lib/web-vitals';
reportWebVitals();

import { initAnalytics } from './lib/analytics';
initAnalytics();

import { bootstrapTheme } from './lib/theme';
bootstrapTheme();

import { bootstrapFeatureFlagsRemote, reconnectFeatureFlagsIfNotLive } from './lib/featureFlagsRemote';
import { onAuthEstablished } from './store/session';
bootstrapFeatureFlagsRemote();
/* 启动时 pre-auth bootstrap+SSE 必 401（cookie 未就绪），401 的 SSE 不会自愈 → flags 停在默认值。
 * auth 建立（/auth/refresh 写入 accessToken=cookie 已新鲜）后重连一次，让后端 flag 生效。 */
onAuthEstablished(() => reconnectFeatureFlagsIfNotLive());

import './i18n';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
/* themes.css contains the codegen'd dark/light/high-contrast palettes.
 * globals.css after = 非 token 的全局样式（元素级规则、渐变、动画）。
 *
 * 注意：globals.css 曾在此覆盖 dark 的 surface/border/text 变量（更深的三层
 * 景深），那组值现已收编进 token 源的 colorTokensDarkWeb、由 themes.css 直接
 * 生成，此处不再有重名变量覆盖。加载顺序仍需保持——globals.css 的元素级规则
 * 依赖 themes.css 先定义好变量。 */
import './styles/themes.css';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
