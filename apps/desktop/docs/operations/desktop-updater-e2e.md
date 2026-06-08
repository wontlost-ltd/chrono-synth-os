# Desktop Updater End-to-End Verification

How to validate the full Tauri auto-update chain on a real machine after
configuring the Cloudflare Worker + GitHub Release pipeline. Pair this
with `desktop-signing-runbook.md` (which covers signing prerequisites)
— this document focuses on the post-release verification path.

## Architecture recap

```
git push v0.x.y                               (1)
       │
       ▼
GitHub Actions release.yml
  ├─ tauri build + sign (per platform)        (2)
  ├─ generate latest.json + .sig with         (3)
  │  TAURI_SIGNING_PRIVATE_KEY
  └─ upload to GitHub Release (draft)         (4)
       │
       ▼ (maintainer Publish on the draft)    (5)
GitHub Release becomes "latest"
       │
       ▼
Cloudflare Worker @ releases.chrono.wontlost.com
  /desktop/{target}/{arch}/{current_version}
       │
       ├─ proxy GET → api.github.com /releases/latest
       ├─ if tag_name == current_version → 204 No Content
       ├─ else → fetch latest.json asset, return body
       │
       ▼
Installed ChronoSynth app (tauri-plugin-updater)
  ├─ verify signature against tauri.conf.json pubkey  (6)
  ├─ download bundle from URL inside latest.json
  └─ install + restart
```

## Cloudflare Worker setup (one-time)

Already documented inline when set up. The Worker code lives in the
Cloudflare dashboard, not this repo. If we ever migrate it to repo:

- Repo path: `cloudflare/updater-worker/index.js`
- Deployed via `wrangler deploy` (CI step in a separate workflow)

For now, source-of-truth is the Cloudflare dashboard. Maintainer with
write access: see `wontlost-ltd/platform` team.

## Pre-release checklist

Before pushing a release tag, confirm:

- [ ] `tauri.conf.json` `plugins.updater.pubkey` matches the public
      half of the key whose private half is in
      `TAURI_SIGNING_PRIVATE_KEY` GitHub Secret.
      Verify with:
      ```bash
      cd chrono-synth-desktop
      npm run lint:updater-pubkey
      # → ✓ updater-pubkey lint: clean (length=152)
      ```
- [ ] `tauri.conf.json` `plugins.updater.endpoints` includes
      `https://releases.chrono.wontlost.com/desktop/{{target}}/{{arch}}/{{current_version}}`.
- [ ] Worker reachable from the public internet:
      ```bash
      curl -i https://releases.chrono.wontlost.com/desktop/darwin-aarch64/aarch64/0.0.0
      # Expect: HTTP/2 200 + JSON body with `version` / `platforms` / `signature`
      ```
- [ ] All seven Apple + two Windows + two Tauri secrets present in
      `Settings → Secrets and variables → Actions` (see
      `desktop-signing-runbook.md` for the full list).

## Releasing a verification build

1. **Bump the version** in `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`. Use a `-rc1` suffix for first end-to-end
   verification so it never reaches real users:
   ```bash
   # in tauri.conf.json and src-tauri/Cargo.toml:
   "version": "0.2.0-rc1"
   ```
2. Commit + push the bump on a branch, open PR, merge to `main`.
3. Tag and push:
   ```bash
   git checkout main && git pull
   git tag v0.2.0-rc1
   git push origin v0.2.0-rc1
   ```
4. The `release.yml` workflow starts. Watch it in the Actions tab.
   Typical end-to-end runtime: 20-30 minutes (macOS notarization is
   the long pole).
5. When the workflow finishes, the release lives as a **Draft** in
   `https://github.com/wontlost-ltd/chrono-synth-desktop/releases`.
   It is NOT visible to the Worker yet — the Worker's
   `api.github.com/releases/latest` query only sees *published*
   releases.

## End-to-end auto-update verification

This is the part that catches "the pubkey doesn't match the signer"
problems before real users get an unfixable broken installer.

### Setup: install an "old" version

You need an *installed* ChronoSynth client running a version older
than the one we just built. Three ways:

- **Cleanest**: dig out the previous release from GitHub Releases
  archive, download the matching installer, install it.
- **Quickest**: bump `src-tauri/tauri.conf.json` version locally to
  `0.0.1`, run `npm run tauri:dev`, leave the app running.
- **Most realistic**: use a clean VM (UTM on macOS, Hyper-V on
  Windows, a fresh Docker container on Linux), install the
  previous release there.

For first-ever verification, use the dev build path:
```bash
cd chrono-synth-desktop
# Temporarily edit src-tauri/tauri.conf.json: "version": "0.0.1"
# (Don't commit this — only for the dev run.)
npm run tauri:dev
```

### Step 1: Verify the Worker returns the latest manifest

From your dev machine, with the app running:
```bash
curl -i 'https://releases.chrono.wontlost.com/desktop/darwin-aarch64/aarch64/0.0.1' | tail -20
```

Expected:
- Status `200 OK`
- `Content-Type: application/json`
- Body parses as JSON containing:
  ```json
  {
    "version": "0.2.0-rc1",
    "notes": "...",
    "pub_date": "2026-...",
    "platforms": {
      "darwin-aarch64": {
        "signature": "<base64-minisign>",
        "url": "https://github.com/wontlost-ltd/chrono-synth-desktop/releases/download/v0.2.0-rc1/..."
      },
      ...
    }
  }
  ```

If you get `204 No Content`, the GitHub API thinks the latest
*published* release is already <= 0.0.1. That means the v0.2.0-rc1
release is still in Draft — **publish it manually** at
`https://github.com/wontlost-ltd/chrono-synth-desktop/releases` for
the verification to proceed.

If you get `502` or `404`, the Worker can't reach GitHub or the
release has no `latest.json` asset. Check Worker logs in the
Cloudflare dashboard.

### Step 2: Verify the signature locally

Catch pubkey mismatches before the client does:
```bash
# Download latest.json + its signature directly from the worker
curl -sS 'https://releases.chrono.wontlost.com/desktop/darwin-aarch64/aarch64/0.0.1' > /tmp/latest.json
jq -r '.platforms["darwin-aarch64"].signature' /tmp/latest.json > /tmp/latest.json.sig
# The bundle URL is what Tauri will download; pull a few bytes to confirm it's reachable
curl -sI "$(jq -r '.platforms["darwin-aarch64"].url' /tmp/latest.json)" | head -5
# Expect: HTTP/2 200 or 302
```

Then verify against the pubkey:
```bash
# Extract pubkey from tauri.conf.json
PUBKEY=$(jq -r '.plugins.updater.pubkey' src-tauri/tauri.conf.json)
echo "$PUBKEY" > /tmp/chrono.pub
# tauri-signer verifies signatures of release artifacts, NOT of the
# latest.json itself. To verify the bundle:
BUNDLE_URL=$(jq -r '.platforms["darwin-aarch64"].url' /tmp/latest.json)
curl -sL "$BUNDLE_URL" -o /tmp/bundle.tar.gz
SIG=$(jq -r '.platforms["darwin-aarch64"].signature' /tmp/latest.json)
echo "$SIG" > /tmp/bundle.tar.gz.sig
npx @tauri-apps/cli signer verify -k /tmp/chrono.pub -s /tmp/bundle.tar.gz.sig /tmp/bundle.tar.gz
# Expect: "Signature verified successfully"
```

If verify fails: the `TAURI_SIGNING_PRIVATE_KEY` in GitHub Secrets
does not pair with the `pubkey` in `tauri.conf.json`. Fix and re-run
the release.

### Step 3: Trigger the in-app update

With the dev app still running (showing version 0.0.1), the Tauri
updater polls `endpoints` on a schedule. Two ways to force an
immediate poll:

- Restart the app — the updater polls once at startup.
- Add a temporary debug button calling
  `appUpdater().checkUpdate()` from `@tauri-apps/api/updater`.

Expected sequence in the app logs (Tauri dev console):
```
[updater] checking for update...
[updater] update available: 0.2.0-rc1
[updater] downloading from https://github.com/.../v0.2.0-rc1/...
[updater] signature verified
[updater] installing... (app restarts)
```

If you see "signature mismatch" or "no update available", capture:
- The full Worker URL the client requested (look in
  `~/Library/Logs/com.wontlost.chrono-synth-desktop/` on macOS).
- The response body (Cloudflare Worker logs, real-time tab).
- The pubkey vs. the signer used at release time.

### Step 4: Confirm post-install state

After the auto-update restarts the app:
- The app shows version `0.2.0-rc1`.
- `~/Library/Application Support/com.wontlost.chrono-synth-desktop/`
  (or Windows equivalent) still has the encrypted SQLite database
  from before — auto-update preserves user data.
- `tauri-plugin-updater` logs no further "update available" on
  next poll (until you cut another release).

## Cleanup after rc verification

Once the e2e succeeds:
1. **Revert the local `0.0.1` version bump** — you only made it to
   create a stale dev build. Do NOT commit.
2. Decide whether to keep or yank the `-rc1` release:
   - If the verification was clean, leave the draft as historical
     reference (or delete it — releases are cheap).
   - If something failed and we're cutting `-rc2`, draft can stay.
3. When ready for the real release, repeat without `-rc` suffix.

## Failure modes catalogue

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl ... releases.chrono.wontlost.com` returns Cloudflare error page | Worker not deployed or DNS not pointed | Re-run Worker deploy in Cloudflare dashboard; verify custom domain bound |
| `curl` returns 502 from Worker | GitHub API rate-limited or down | Wait + retry; consider authenticating the Worker's GitHub API call with a token (future hardening) |
| `curl` returns 204 No Content | Either: (a) latest *published* release tag matches the `current_version` in the URL — normal "you're up to date", or (b) the repo has NO published releases yet (GitHub API returns 404, the Worker maps it to 204). Both are "no update" from the client's perspective. | If (a), publish the draft release or pass an older `current_version`. If (b), this is the expected state before the first release is cut. |
| `signer verify` fails | pubkey in `tauri.conf.json` ≠ private key in `TAURI_SIGNING_PRIVATE_KEY` secret | Re-run `tauri signer generate` cleanly; update both the secret and the conf; cut a new release |
| Client says "update available" but install fails partway | Bundle URL returned 4xx, or notarization stripped during transit | Verify with `curl -L $BUNDLE_URL -o /tmp/x && file /tmp/x` — file should match expected installer type for the platform |
| Update succeeds but app crashes on next launch | Schema migration regression, NOT updater-related | Check `~/Library/Application Support/.../logs`; if migration failed, reinstall from clean install |

## Production release after verification

Once `-rc1` validates end-to-end:

1. Set the production version (no `-rc` suffix), e.g. `0.2.0`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. After workflow completes, **publish** the draft release.
4. Within minutes, all installed clients on `< 0.2.0` start picking
   up the update on their next polling interval (5-30 min depending
   on Tauri default).
5. Monitor crash reports + auto-update success rate for 24h before
   considering the release stable.
