import { initSentry } from './lib/sentry';
initSentry();

import { reportWebVitals } from './lib/web-vitals';
reportWebVitals();

import { initAnalytics } from './lib/analytics';
initAnalytics();

import { bootstrapTheme } from './lib/theme';
bootstrapTheme();

import { bootstrapFeatureFlagsRemote } from './lib/featureFlagsRemote';
bootstrapFeatureFlagsRemote();

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
