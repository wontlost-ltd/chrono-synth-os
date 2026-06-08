/**
 * Storybook preview config — applies to every story.
 *
 * Wires three things every component needs:
 *   1. global CSS (globals.css + themes.css from the design-token
 *      codegen) so stories see the same CSS variables the real app does
 *   2. a theme switcher toolbar (light / dark / high-contrast) that
 *      sets `data-theme` on <html> at render time — same mechanism
 *      the app's ThemeProvider uses, so what you see in SB matches
 *      what you see in the app
 *   3. global a11y rules: all axe rules enabled by default; per-story
 *      overrides via the `parameters.a11y` story metadata if a known
 *      false-positive needs silencing
 */
import type { Preview, Decorator } from '@storybook/react-vite';
import React, { useEffect } from 'react';
import '../src/styles/globals.css';
import '../src/styles/themes.css';
/* SB needs i18next initialised before any story renders a component
 * that calls useTranslation(). The side-effectful import here mirrors
 * what main.tsx does in production. */
import '../src/i18n';

type ThemeName = 'light' | 'dark' | 'high-contrast';

const ThemeDecorator: Decorator = (Story, context) => {
  const theme = (context.globals.theme ?? 'light') as ThemeName;
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);
  return React.createElement(Story);
};

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      /* axe will fail on serious/critical violations; "incomplete"
       * issues are surfaced but not fatal in the addon panel. */
      element: '#storybook-root',
      manual: false,
    },
    /* Backgrounds addon is redundant with the theme switcher since
     * each theme already controls page background via tokens. */
    backgrounds: { disable: true },
    /* Chromatic modes — without this, the upload only snapshots the
     * default global (light) and a token regression that only shows
     * up in dark or high-contrast slips through. Each mode tells
     * Chromatic to render the story once per theme global; the
     * resulting diff matrix is "stories × 3" instead of "stories × 1".
     * See https://www.chromatic.com/docs/modes */
    chromatic: {
      modes: {
        light: { globals: { theme: 'light' } },
        dark: { globals: { theme: 'dark' } },
        'high-contrast': { globals: { theme: 'high-contrast' } },
      },
    },
  },
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Design-token theme to apply to the rendered story',
      defaultValue: 'light',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
          { value: 'high-contrast', title: 'High contrast' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [ThemeDecorator],
};

export default preview;
