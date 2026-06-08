# Chromatic setup

Chromatic is the visual-regression backstop for the design-token +
component-library work that landed under §8 Step 11. Every PR that
touches components, styles, tokens, or stories runs a Storybook build
and ships it to Chromatic, which diffs every story (across all three
theme globals — light / dark / high-contrast) against the accepted
baseline on `main`.

## Why this exists

The static contrast lint (`npm run lint:contrast` in chrono-synth-os)
catches token-level WCAG regressions, and `@storybook/addon-a11y`
catches per-component axe-core failures. Chromatic catches the third
class: visual regressions that don't trip either tool — a Tailwind
class change that shifts a layout by 4px, a token tweak that subtly
desaturates a chart line, a theme-variant bug that only shows up in
high-contrast.

## One-time onboarding

1. Sign up at <https://www.chromatic.com> with the GitHub account
   that owns the `chrono-synth-web` repo.
2. Create a new project pointing at the repo. Chromatic will detect
   it as a Storybook project automatically.
3. Copy the project token from the Chromatic project's Manage page
   (`Project token: chpt_...`).
4. Add it as a GitHub Actions secret on the repo:
   - Settings → Secrets and variables → Actions → New repository secret
   - Name: `CHROMATIC_PROJECT_TOKEN`
   - Value: the `chpt_...` string
5. Push a commit on `main` (or merge an existing PR). The Chromatic
   action will run, upload the first build, and mark every story as
   the accepted baseline. Subsequent PRs will diff against that.

## Day-to-day workflow

- Open a PR that changes any of:
  - `src/**/*.tsx`, `src/**/*.ts`, `src/**/*.css`
  - `src/styles/**`, `packages/design-tokens/**`
  - `.storybook/**`
- The `Chromatic / Visual regression` GitHub check runs and produces
  a "Visual changes" link in the PR.
- Open that link in the Chromatic UI. For each changed story:
  - **Accept** if the change is intentional (e.g. a design tweak).
  - **Reject + push fix** if it's a regression.
- The PR check stays green either way (`exitZeroOnChanges: true`);
  the human-acceptance step in Chromatic is what gates merge.
- On merge to `main`, the workflow auto-accepts the new baseline
  (`autoAcceptChanges` is true on push to main).

## Failure modes

- **`error: project token not found`** — secret not set or PR is
  from a fork. The workflow's `if:` skips fork PRs to avoid leaking
  the token; ask the contributor to push to a branch instead.
- **`No stories found`** — `npm run build-storybook` succeeded but
  produced an empty `storybook-static/`. Usually means the stories
  glob in `.storybook/main.ts` doesn't match. Test locally with
  `npm run storybook` first.
- **`vite-plugin-pwa: precache limit exceeded`** — should not happen
  anymore: `vite.config.ts` drops PWA when building Storybook (see
  the `isStorybookBuild` detection there). If it resurfaces, the SB
  build environment likely isn't setting `npm_lifecycle_event` —
  check the detection conditions.
- **Storybook 9 / Vite 8 peer warnings** — expected, suppressed via
  `--legacy-peer-deps` in CI. The Vite 8 surface SB 9 uses is
  API-compatible.

## Token rotation

If the project token is compromised:

1. Chromatic dashboard → Manage → Rotate project token.
2. Update the GitHub secret with the new value.
3. Optional: redact the old token from any leaked location.

No code changes are needed — the workflow reads the secret each run.

## Local testing

To reproduce the CI flow locally:

```sh
npm ci --legacy-peer-deps
npm run build-storybook
npx chromatic --project-token=<chpt_...>
```

This uploads from your machine; useful for sanity-checking before
merging the workflow itself.
