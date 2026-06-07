/**
 * Storybook 9 config — drives `npm run storybook` for local dev,
 * `npm run build-storybook` for the static bundle that Chromatic
 * uploads in CI.
 *
 * Why Storybook here:
 *   - GA Stage 4 of design-tokens work: pin every component's three
 *     theme variants (light, dark, high-contrast) as visual snapshots
 *     so a token tweak that ripples into a component is caught before
 *     it reaches users.
 *   - Doubles as the design system's component catalog (currently
 *     thin; will grow as we extract reusable patterns from
 *     src/components/ui/).
 *
 * Why @storybook/addon-a11y:
 *   - Each story automatically runs axe-core; per-rule failures
 *     surface in the addon panel + (via `test-storybook`) can fail
 *     CI on regression.
 *
 * Stories live next to source: `src/**\/*.stories.tsx`. Keep them
 * collocated so component edits and story updates land in the same PR.
 */
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  typescript: {
    /* skip type-checking inside SB to keep the dev loop fast; tsc -p
     * tsconfig.json in the main `npm run typecheck` is the source of
     * truth for types. */
    check: false,
    /* React 19 needs explicit jsx transform setting; default is fine. */
    reactDocgen: 'react-docgen-typescript',
  },
  /* Vite 8 peer-dep mismatch is silenced via npm --legacy-peer-deps
   * at install. Storybook 9.x targets Vite 5–7 in peer ranges; the
   * Vite 8 surface we touch (server / build commands, plugin API)
   * is API-compatible.
   *
   * `viteFinal` also strips plugins that don't apply to the SB
   * preview build:
   *   - vite-plugin-pwa: tries to precache SB's own runtime chunks
   *     (~2MB globals-runtime.js) and fails the build. PWA service
   *     workers have no meaning in the SB context anyway.
   *   - sentry vite plugin (if present): SB previews aren't shipped
   *     to users, no source-map upload needed.
   */
  async viteFinal(config) {
    const dropPlugins = ['vite-plugin-pwa', 'sentry-vite-plugin'];
    if (Array.isArray(config.plugins)) {
      config.plugins = config.plugins.filter((p: unknown) => {
        if (!p || typeof p !== 'object') return true;
        const name = (p as { name?: string }).name;
        return !name || !dropPlugins.some(d => name.includes(d));
      });
    }
    return config;
  },
};

export default config;
