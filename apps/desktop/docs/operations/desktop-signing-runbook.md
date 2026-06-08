# Desktop Signing & Release Runbook

How to sign, notarize, and ship a ChronoSynth desktop release.

## Prerequisites (one-time per environment)

### macOS

1. **Apple Developer account** with admin access to the team that owns
   the bundle id `com.wontlost.chrono-synth-desktop`.
2. **Developer ID Application** certificate downloaded from the Apple
   Developer portal and installed to the system keychain. Export the
   `.p12` (with password) for CI use.
3. **App-specific password** for `notarytool`:
   <https://account.apple.com> → Sign-in & Security → App-Specific
   Passwords. Generated value goes into the `APPLE_ID_PASSWORD`
   secret.
4. **Tauri signing keypair** — generated once with `tauri signer
   generate -w ~/chrono-synth-desktop-tauri.key`. Public key goes
   into `tauri.conf.json` `plugins.updater.pubkey`; private key goes
   into the `TAURI_SIGNING_PRIVATE_KEY` secret.

### Windows

1. **Code Signing Certificate** (EV strongly recommended for
   SmartScreen reputation). PFX file exported with password.
2. **signtool.exe** is bundled with Windows SDK; CI installs the
   SDK automatically.

### Linux

`.AppImage` and `.deb` are signed via the Tauri updater keypair only
— no platform-level signing. Distribution channels (apt repo, AppImage
update server) are operator-managed.

## CI secrets

Set these in `Settings → Secrets and variables → Actions → Repository
secrets`:

| Secret name | Used for |
|---|---|
| `APPLE_CERTIFICATE_BASE64` | `.p12` of Developer ID, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `"Developer ID Application: Wontlost Ltd (TEAMID)"` |
| `APPLE_ID` | the team-owner Apple ID email |
| `APPLE_ID_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | 10-char team id from the Developer portal |
| `WINDOWS_CERTIFICATE_BASE64` | `.pfx`, base64-encoded |
| `WINDOWS_CERTIFICATE_PASSWORD` | password for the `.pfx` |
| `TAURI_SIGNING_PRIVATE_KEY` | private key from `tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password protecting the private key |

## Releasing

The `release.yml` workflow runs on push of a tag matching `v*.*.*`:

```bash
# from a clean main with the bumped version in tauri.conf.json:
git tag v0.2.0
git push origin v0.2.0
```

Workflow steps per platform:

1. Builds the frontend (`npm run build`).
2. Runs `tauri build` with platform-specific bundling.
3. Signs the bundle with the platform certificate.
4. **macOS**: notarizes via `xcrun notarytool` and staples the ticket.
5. Generates the Tauri update manifest (`latest.json`) — signed with
   the updater private key.
6. Uploads bundles + `latest.json` as a draft GitHub Release.

The release stays in **draft** until a maintainer reviews installers
on a fresh VM and publishes manually. This is the gate that catches
"signed but won't install on macOS Sonoma" issues before customers
do.

## Updater rollout

The `latest.json` manifest is what installed apps poll. Hosting
options:

1. **GitHub Releases** (default; the workflow uploads it as a
   release asset). Set the updater endpoint to
   `https://github.com/wontlost-ltd/chrono-synth-desktop/releases/latest/download/latest.json`.
2. **CDN-hosted endpoint** for faster propagation. Mirror the file
   via the `releases.chrono.example.com` host (matches the endpoint
   in `tauri.conf.json`).

The pubkey in `tauri.conf.json` must match the signer of `latest.json`,
or the desktop app will reject the update with a clear error.

## Rollback

A buggy release that's already shipped can be disabled by editing
`latest.json` to point back at the previous version's bundle URL and
re-signing. Existing installs that auto-updated will need a new
release to roll *forward* — the updater never rolls back installed
binaries.

If a release was so bad you need clients to reinstall:

1. Pull the offending release from GitHub Releases (move to draft).
2. Notify users via the in-app notification channel (P3.7 narrative
   onboarding).
3. Don't try to "yank" the AppImage / DMG mid-flight — they're
   already on user disks.

## Verifying a signed bundle locally

```bash
# macOS
codesign -dv --verbose=4 /Applications/ChronoSynth.app
spctl -a -vvv -t install /Applications/ChronoSynth.app  # should output "accepted"

# Windows
Get-AuthenticodeSignature .\ChronoSynth.exe

# Linux (Tauri updater signature)
tauri signer verify --signature latest.json.sig latest.json
```

## Known issues

- `signingIdentity` was removed from `tauri.conf.json` in Tauri 2;
  it's now set via the `APPLE_SIGNING_IDENTITY` env var inside the
  release workflow. Don't add it back to the JSON — Tauri 2's
  schema rejects it.
- AppImage updater signature must use the **same** keypair across
  releases or installed clients reject the update silently. If the
  pubkey ever rotates, the next release must be installed manually
  by users.
