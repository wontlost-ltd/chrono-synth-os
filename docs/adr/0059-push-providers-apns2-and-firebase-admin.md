# 0059 — Push providers: apns2 (iOS) + firebase-admin (Android)

> 注：本 ADR 原误用编号 0032（与 0032-ppf-v1-zod-schemas 冲突），已重编为 0059（全维评审 G5）。

**Status:** Accepted
**Date:** 2026-05-10
**Scope:** real-device push delivery for the avatar-cross-device sync feature

## Context

The avatar-cross-device sync feature (see `.claude/plan/avatar-cross-device.md` and `.claude/plan/execution-plan-2026-05.md` §EP-3.x) requires the server to send notifications directly to user devices without relying on a third-party message broker. The existing `PushService` interface and `MockPushService` implementation prove out the call shape end-to-end, but the gap to a real production deployment is two concrete providers: one for iOS (APNs) and one for Android (FCM).

Three production-grade options exist for each platform. We evaluated them against five criteria: maintenance status, dependency footprint, auth flow, type safety, and operational visibility.

### iOS / APNs candidates

| Library | Maintenance (last commit) | Auth | Notes |
|---------|---------------------------|------|-------|
| **`apns2`** | Active (Q1 2026) | Token (.p8) + Cert | Pure ESM, no native bindings. Used by Postmark, Mailgun mobile teams. |
| `node-apn` | Stalled (2023) | Cert only | Popular historically; v3 was abandoned. Token-based auth requires a fork. |
| Direct HTTP/2 | n/a | Token | DIY against the APNs HTTP/2 endpoint. Saves one dep but reimplements the JWT signing + connection pool. |

### Android / FCM candidates

| Library | Maintenance | Auth | Notes |
|---------|-------------|------|-------|
| **`firebase-admin`** | Active (Google) | Service account JSON | Official SDK. Heavy (~3 MB) but the only library Google supports for FCM v1. |
| `fcm-node` | Active community | Server key (legacy) | Uses the legacy /fcm/send endpoint that Google has scheduled for sunset (2024-06; still works as of 2026 but treated as deprecated). |
| Direct REST | n/a | Service account | Reimplements Google's OAuth2 token exchange. |

## Decision

- **iOS:** use **`apns2`** for the APNs provider (`src/agent/push/apns-provider.ts`).
- **Android:** use **`firebase-admin`** for the FCM provider (`src/agent/push/fcm-provider.ts`).

Both providers conform to the `PushProvider` interface (single-platform; one provider per channel). Routing across platforms happens in `PushDispatcher`, which looks up the device's `platform` column and selects the right provider. `MockPushProvider` remains as the fallback for `platform = 'mock'` and for any unit / integration test that does not want to install real credentials.

## Consequences

**Positive**

- Both libraries are actively maintained on the same release cadence as their respective platforms (Apple iOS / Google FCM v1).
- Both support token-based auth, which is the only future-proof option (cert-based APNs is in long-term sunset; FCM legacy server-key was deprecated in 2024).
- `apns2` is pure JS ESM; `firebase-admin` ships a Node binary but no native compilation step. CI builds on Linux/macOS/Windows GitHub-hosted runners with no extra system packages.
- Clear separation: `PushProvider` (single channel, knows nothing about routing) vs `PushService` (multi-channel, routes by device platform). Each provider has a single failure surface.

**Negative**

- `firebase-admin` adds ~3 MB to the server bundle and pulls in Google's `gcp-metadata` even when running outside GCE. We accept this — the alternative (DIY REST + OAuth2) would re-derive a small portion of `firebase-admin` and we would own the edge cases ourselves.
- Two libraries means two security-update paths to track.
- `apns2`'s connection pool keeps a long-lived HTTP/2 connection to APNs — server lifecycle code must call `.close()` on shutdown to avoid a held socket.

**Risk acceptance**

- We do **not** ship cert-based APNs auth. If a deployment cannot get a `.p8` token key, they can use the mock provider until they can.
- We do **not** support legacy FCM (`/fcm/send`). New deployments must use FCM v1 with a service-account JSON.

## Operational requirements

Configuration schema (env vars):

| Variable | Purpose |
|----------|---------|
| `CHRONO_APNS_KEY_ID` | APNs token key id (`.p8` filename without prefix/suffix) |
| `CHRONO_APNS_TEAM_ID` | Apple Developer team id |
| `CHRONO_APNS_BUNDLE_ID` | iOS app bundle id (must match the app build) |
| `CHRONO_APNS_KEY_PATH` | Filesystem path to the `.p8` private key |
| `CHRONO_APNS_PRODUCTION` | `true` for production APNs gateway, `false` for sandbox (default sandbox) |
| `CHRONO_FCM_SERVICE_ACCOUNT_PATH` | Filesystem path to the FCM service-account JSON |

Token-invalidation feedback: both providers translate provider-specific error responses (APNs `BadDeviceToken`, FCM `UNREGISTERED`) into a `tokenInvalidated` event that the host logs and uses to mark the row in `device_tokens` as `is_invalid_at = now()`. This is the only side channel from the push framework into the persistence layer; everything else is pure `Result<>`.

## References

- APNs HTTP/2 reference: https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server
- FCM v1 HTTP API: https://firebase.google.com/docs/cloud-messaging/migrate-v1
- `apns2`: https://github.com/AndrewBarba/apns2
- `firebase-admin`: https://firebase.google.com/docs/admin/setup
- Plan: `.claude/plan/execution-plan-2026-05.md` §EP-3.1 — §EP-3.5
