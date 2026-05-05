# `@chrono/kernel` 1.0.0 Release Runbook

> Walk-through for cutting and publishing the first public release of `@chrono/kernel`. The package has been engineered for this since the P4-A spec landed; this document is the operational sequence to actually flip the switch.

**Owner:** release engineer
**Estimated time:** 30 minutes (excluding npm 2FA flow)
**Pre-release sign-off:** PPF v1 spec freeze (see `docs/ppf/v1/spec.md`)

---

## 0. Prerequisites

- [ ] An npm account with publish rights to the `@chrono` scope
- [ ] 2FA configured on that account (`npm profile get` shows `auth-and-writes`)
- [ ] Local `npm whoami` returns the expected user
- [ ] Working tree clean: `git status` shows no uncommitted changes
- [ ] Branch up-to-date with `origin/main`
- [ ] All tests green: `npm run test:golden`
- [ ] PPF v1 spec checksum has not changed since freeze (verify against `docs/ppf/v1/spec.md` and `docs/ppf/v1/test-vectors/minimal-valid.json`)

## 1. Pre-flight verification (no side effects)

These steps don't touch npm; they must all pass.

```bash
# 1a. Lint imports — kernel must remain zero-dep
npm run check:forbidden-imports

# 1b. Typecheck + build the entire monorepo
npm run typecheck
npm run build

# 1c. Run the kernel zero-dep contract test in isolation
node --test --test-force-exit dist/test/contract/kernel-zero-deps.test.js

# 1d. Run the PPF v1 vector tests in isolation
node --test --test-force-exit dist/test/contract/ppf-v1-test-vectors.test.js

# 1e. Dry-run the package contents
cd packages/kernel
npm pack --dry-run
```

Inspect the `npm pack --dry-run` output:

- `LICENSE` and `README.md` MUST appear in the file list
- `dist/index.js` and `dist/index.d.ts` MUST appear
- No `*.test.js` files should be in the package (they live under `src/test/`, outside `packages/kernel/`)
- Tarball size sanity check: < 1 MB compressed (current: ~207 kB)

## 2. Smoke-test the tarball locally

```bash
cd packages/kernel
npm pack                                     # produces chrono-kernel-1.0.0.tgz
mkdir /tmp/chrono-kernel-smoke && cd /tmp/chrono-kernel-smoke
npm init -y
npm install <path-to-tarball>
node -e "import('@chrono/kernel').then(k => { console.log('exports:', Object.keys(k).length); console.log('zero-dep ok:', !require('@chrono/kernel/package.json').dependencies); })"
```

Expected output:
- `exports: <large number>` (currently 200+)
- `zero-dep ok: true`

If any of the above fails, **abort** and fix before retrying.

## 3. Cut 1.0.0

```bash
cd packages/kernel

# 3a. Bump the version in packages/kernel/package.json from 0.1.0 → 1.0.0
#     Use npm version (creates the version commit + tag)
npm version 1.0.0 --no-git-tag-version

# 3b. Verify the change is the only diff
git diff packages/kernel/package.json

# 3c. Commit + tag
cd ../..
git add packages/kernel/package.json
git commit -m "chore(kernel): cut 1.0.0"
git tag -a kernel-v1.0.0 -m "@chrono/kernel 1.0.0"
```

## 4. Publish

```bash
cd packages/kernel
npm publish                                  # opens 2FA prompt; access:public is in publishConfig
```

**If something goes wrong here**: `npm unpublish @chrono/kernel@1.0.0` is allowed within 72 hours but **only as a last resort** — npm scarcity rules treat unpublishes as version-burning. Prefer cutting `1.0.1` with the fix.

## 5. Post-publish verification

```bash
# 5a. Confirm the published artifact
npm view @chrono/kernel@1.0.0

# 5b. Install from the registry into a clean directory
mkdir /tmp/chrono-kernel-postpublish && cd $_
npm init -y
npm install @chrono/kernel@1.0.0
node -e "console.log(require('@chrono/kernel/package.json').version)"
# Expected: 1.0.0
```

## 6. Push the tag and update status

```bash
cd <repo root>
git push origin main kernel-v1.0.0
```

Then update `.claude/plan/status-2026-05.md`:
- P4-B row: `🟢 Ready` → `✅ Done`
- Add a "Released artifacts" section linking to `https://www.npmjs.com/package/@chrono/kernel/v/1.0.0`

## 7. Open the next-version branch

After publish, the working version on `main` should already become `1.0.1-dev` to prevent accidental re-publish of the released tag. Bump:

```bash
cd packages/kernel && npm version 1.0.1-dev --no-git-tag-version
git commit -am "chore(kernel): bump main to 1.0.1-dev"
```

---

## Rollback procedure

If a defect is discovered post-publish:

1. **Within 72h of publish**: `npm unpublish @chrono/kernel@1.0.0` (use sparingly — npm flags repeat unpublishers)
2. **After 72h**: `npm deprecate @chrono/kernel@1.0.0 "use 1.0.1+"` and immediately publish 1.0.1 with the fix
3. Update `docs/release/kernel-1.0.0-runbook.md` post-mortem section with the root cause

---

## Checklist summary

```
[ ] All prerequisites met (§0)
[ ] Pre-flight verification clean (§1)
[ ] Local tarball smoke test passes (§2)
[ ] Version bump committed + tagged (§3)
[ ] npm publish succeeded (§4)
[ ] Post-publish install succeeds (§5)
[ ] Tag pushed (§6)
[ ] main branch bumped to 1.0.1-dev (§7)
[ ] Status report updated
```
