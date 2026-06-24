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
 * globals.css after = brand v2 overrides (deeper surface tiers, gradient
 * tokens) win on duplicate variable names. Keep this order intact. */
import './styles/themes.css';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
