# Desktop accessibility coverage matrix

Source for §8 Step 14 of the GA plan. Lists the assistive-technology
matrix the desktop shell is expected to support at GA, the routes
that have been actively exercised under each AT, and the owner /
status / open issue for each cell.

The matrix exists so an external auditor can scan one page to see
what's been covered, what's deferred, and who's accountable. It is
NOT a substitute for a full Section 508 / WCAG 2.1 AA audit — it's a
self-attestation that the team has stress-tested the common assistive
flows.

## Scope

This matrix covers the **desktop shell** (chrono-synth-desktop, Tauri
2 + React + Tailwind v4). The web SPA's matrix is tracked separately
in `chrono-synth-web/docs/operations/a11y-runbook.md`.

In-scope surfaces:

- Persona list + detail (the primary daily-use surface)
- Persona onboarding wizard (first-launch funnel)
- Conflict inbox + 5-class resolution UI (Step 12)
- Settings (API URL + token configuration)
- Title bar + sidebar navigation

Out-of-scope for GA (tracked in follow-ups):

- Decision-engine deep visualisation views
- Drift-review modals
- Help / docs viewer

## Matrix

| Surface | macOS VoiceOver | Windows NVDA | Keyboard-only | High-contrast | Owner |
|---|---|---|---|---|---|
| Persona list | ✅ Verified 2026-05-22 | ⚠️ Partial — 3 SR labels missing on PersonaCard | ✅ Tab order matches DOM | ✅ Token-driven (Step 11) | @rpang |
| Persona detail | ✅ Verified 2026-05-22 | ⚠️ Same as list | ✅ Form fields labelled | ✅ Token-driven | @rpang |
| Persona onboarding (first launch) | ✅ Verified 2026-05-23 | 🟡 Not yet tested | ✅ Verified | ✅ Token-driven | @rpang |
| Conflict inbox (Step 12) | 🟡 Not yet tested | 🟡 Not yet tested | ✅ Verified — list buttons + radio fieldset reachable | ✅ Token-driven | @rpang |
| Conflict resolution panels (5 types) | 🟡 Not yet tested | 🟡 Not yet tested | ✅ Verified — submit gating works under keyboard | ✅ Token-driven, policy panel uses error/40 banner | @rpang |
| Manual-merge editor | 🟡 Not yet tested | 🟡 Not yet tested | ✅ Verified — textarea + aria-invalid bound | ✅ Token-driven | @rpang |
| Settings | ✅ Verified 2026-05-19 | 🟡 Not yet tested | ✅ Verified | ✅ Token-driven | @rpang |
| Sidebar navigation | ✅ Verified 2026-05-19 | 🟡 Not yet tested | ✅ Verified — landmark role=nav | ✅ Token-driven | @rpang |
| Title bar | ⚠️ Tauri-native — relies on macOS window chrome | ⚠️ Tauri-native — relies on Windows window chrome | n/a | n/a | tauri-rs |

Legend:
- ✅ Verified — manually exercised end-to-end under this AT with no
  blockers. Date is the last verification.
- ⚠️ Partial — works for primary flow but has known gaps documented
  in the linked issue.
- 🟡 Not yet tested — surface exists, AT pass is on the followup
  backlog, no known regressions.
- ❌ Blocked — known broken under this AT, do NOT ship until resolved.
- n/a — surface doesn't apply (native OS-rendered chrome, etc.).

## Methodology

### macOS VoiceOver

- macOS 14+ with VoiceOver enabled (`⌘ + F5`).
- Verifier walks every interactive control in DOM order via VO + arrow
  keys, confirming each control's accessible name + role + state.
- Custom controls (radio group on ResolutionFooter, manual-merge
  textarea with `aria-invalid` + `aria-describedby`) verified to
  announce error messages on submit attempt.

### Windows NVDA

- Windows 11 + NVDA 2024.x.
- Same walkthrough as VoiceOver. Specifically watch for differences
  in `aria-current="true"` (NVDA announces "current page" — VO doesn't).
- Tab key behaviour in `<fieldset><legend>` groups occasionally
  differs across NVDA versions; lock to 2024.x for the GA audit.

### Keyboard-only

- All interactive elements reachable via Tab.
- Tab order matches visual order (DOM order).
- Focus ring visible at all times (token `--color-border-focus`
  enforced by `lint:contrast` against canvas background).
- Esc closes modals / drawers.
- Enter / Space activates buttons + radio selection.

### High-contrast

- macOS: System Settings → Display → Increase contrast.
- Windows: Settings → Accessibility → Contrast themes → High Contrast Black.
- Token system applies `[data-theme='high-contrast']` overrides; values
  validated by `chrono-synth-os` `lint:contrast` (WCAG AAA ≥7:1 for
  body text on canvas).

## Process

Re-verification cadence:

- Every time a row's surface changes (PR-level), the owner re-runs the
  AT pass for that row and updates the date.
- Quarterly full sweep across all rows (covers AT version updates).
- Before GA: every 🟡 must be either ✅ or explicitly documented as
  out-of-scope with a follow-up ticket.

## Known issues + tracking

- **NVDA / persona card labels** — three card meta fields (growth
  index, reputation, wallet) render their numeric values with no
  associated `aria-label`. NVDA announces the value but not the
  semantic. Fix: wrap each value in a `<span aria-label="growth index">`
  pattern. Tracked: TODO (post-GA).
- **VoiceOver / conflict inbox** — not yet verified. The implementation
  uses native `<button>` rows + `aria-current` on the selected entry,
  which should announce correctly, but the verification pass hasn't
  happened.

## References

- WCAG 2.1 AA: <https://www.w3.org/WAI/WCAG21/quickref/>
- Apple HIG accessibility: <https://developer.apple.com/design/human-interface-guidelines/accessibility>
- NVDA user guide: <https://www.nvaccess.org/files/nvda/documentation/userGuide.html>
- ARIA Authoring Practices 1.2: <https://www.w3.org/WAI/ARIA/apg/>
