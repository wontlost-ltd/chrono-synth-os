# apps/mobile — ChronoCompanion Mobile (iOS + Android)

> 🧭 Per [ADR-0046](../../docs/adr/0046-dual-product-companion.md), this
> directory is the **primary mobile host for ChronoCompanion** (the
> consumer-facing C-end product). Today it carries a 4-screen PoC; the
> roadmap to a 9-12 screen production app is in
> [`docs/plan/companion-roadmap.md`](../../docs/plan/companion-roadmap.md)
> Phase 2-4.

## Status

**Phase 1 (current) — PoC**. Four screens (Dashboard, SimulationWizard,
ConflictInbox, Billing) on Expo + React Native 0.76. Push, background sync,
secure storage all plumbed via Expo modules. Auth flow + API client wired
against `chrono-synth-os` backend.

This is **not production**. The four screens were carry-overs from EP-2.4
to validate the RN runtime adapter for `@chrono/kernel`. ChronoCompanion
production UX hasn't been built yet.

## Roadmap

| Phase | Adds | Timing (post Enterprise GA) |
|-------|------|------------------------------|
| 2 (alpha) | +5-7 screens: CompanionHome / Growth / MemoryDetail / SimulationResult / Settings. Plan-based routing (enterprise stays on current 4 screens; companion users see new 9-12) | +1-2 month |
| 3 (beta) | TestFlight + Play Internal Test. Daily-companion push notifications | +2 months |
| 4 (GA) | App Store + Play Store. Widget (WidgetKit / Glance). Live Activities (iOS 16.1+). HealthKit ingestion. Face ID / Touch ID | +3 months |

## Stack

- Expo SDK 52, React Native 0.76, React 18.3
- `@react-navigation/native` v7 (bottom tabs)
- `@tanstack/react-query` v5 (server state)
- `expo-secure-store` (JWT + keys)
- `expo-notifications` + `expo-task-manager` + `expo-background-fetch`
  (companion daily push + autonomous sync)
- Future (Phase 4): `expo-local-authentication` (Face ID), Apple WidgetKit
  via `expo-modules-core` interop, Live Activities, HealthKit native module

## Why Expo, not bare RN

- Expo's prebuilds give us iOS / Android binaries without owning Xcode
  toolchain installs across the team
- `expo-notifications` + `expo-background-fetch` are the reasons we picked
  this adapter for "data tasks of the companion" — both Live Activities
  glue (`expo-modules-core`) and HealthKit (community module) can land on
  top of an Expo Dev Build without ejecting

## Building locally

Prerequisite: Xcode (iOS) or Android Studio (Android). Node 24.

```bash
cd apps/mobile
npm install
npx expo start --tunnel    # or --localhost for same-network testing
```

`apps/mobile/package.json` consumes `@wontlost-ltd/schema-dsl` and
`@chrono/*` via the OS monorepo workspaces. `apps/mobile/src/api/client.ts`
expects `EXPO_PUBLIC_API_BASE_URL` env (defaults to `http://localhost:3000`
in dev).

## Bundle identifiers (locked by ADR-0046)

| Platform | Identifier |
|----------|-----------|
| iOS | `com.wontlost.companion` |
| Android | `com.wontlost.companion` |

These are GA bundle ids and **cannot change** without app-id migration
through App Store / Play Store. Set in `app.json` before first TestFlight
build.

## Files

| Path | Role |
|------|------|
| `App.tsx` | Root provider stack (QueryClient + Navigation + SafeArea) |
| `src/navigation/TabNavigator.tsx` | Bottom tab nav (current 4 screens) |
| `src/screens/*.tsx` | Per-screen UI |
| `src/sync/` | RuntimeSyncBadge + useMobileSyncState + push + background fetch glue |
| `src/api/client.ts` | Fetch wrapper around `chrono-synth-os` API |
| `src/hooks/useAuth.ts` | JWT login + refresh + secure-store persistence |
| `app.json` | Expo manifest (bundle ids + permissions + plugins) |
