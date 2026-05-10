# 0043 — i18n CJK literal allowlist via `// i18n-allow-cjk:` pragma

**Status:** Accepted
**Date:** 2026-05 (P0.4 i18n cleanup)
**Scope:** `chrono-synth-web/scripts/check-i18n.{sh,py}`, source files using the pragma

## Context

P0.4 added a CI gate that fails any PR introducing un-extracted
CJK (Chinese / Japanese / Korean) literals into UI source files
(`src/{pages,components,features,hooks,layout}/**/*.{ts,tsx}`).
The check rejects characters in the Unicode Han range U+4E00–U+9FFF
that aren't inside a comment.

Three legitimate exceptions surfaced during the sweep:

1. **`LanguageSwitcher.tsx`** — the language picker shows the
   self-name of each language ("中文", "English"). i18n'ing these
   defeats their purpose; an English speaker who picked the wrong
   language needs "中文" labelled in 中文 to navigate back.
2. **`SafetyErrorBanner.tsx`** — `classifyError(message)` keyword-
   matches against backend error strings that can be Chinese
   ("配额", "限流", "注入"). The match string is a *protocol contract*
   with the backend, not UI copy. Translating it would break the
   classifier.
3. **`Onboarding.tsx`** — preset persona templates seed `core_values`
   with default labels ("事业成就", "家庭关系" etc.) that get written
   verbatim into the database. These are user data defaults, not UI
   strings. Translating them would silently corrupt every new user's
   `core_values` table.

We needed a way to mark these exceptions as "intentional, reviewed,
not regression" without disabling the gate or maintaining a separate
allow-list file.

## Decision

**Line-level pragma `// i18n-allow-cjk: <reason>`.**

Any line ending with this comment is exempt from the CJK check.
The pragma must include a reason; the comment-form `// i18n-allow-cjk`
without text is rejected by code review (not by the script —
enforcement is human).

Examples:

```ts
// LanguageSwitcher.tsx
const LANGUAGES = [
  { code: 'zh-CN', label: '中文' }, // i18n-allow-cjk: language self-name
  { code: 'en-US', label: 'English' },
];

// SafetyErrorBanner.tsx
if (lower.includes('quota') || lower.includes('配额')) return 'quota'; // i18n-allow-cjk: backend keyword match

// Onboarding.tsx
{ id: 'career', values: [{ label: '事业成就', weight: 0.9 }, ...] }, // i18n-allow-cjk: seed data written to DB
```

The `check-i18n.py` script (`scripts/check-i18n.py`) detects the
pragma via regex `//\s*i18n-allow-cjk\b` and skips the line.

## Consequences

**Wins**

- One mechanism handles all three exception classes plus any future
  one we don't yet know about. No separate allow-list file to drift
  out of sync.
- The pragma sits on the line it exempts. A reviewer reading the
  diff sees the pragma + the literal + the reason in one glance.
  No "let me check the allow-list to see if this was OK".
- Self-documenting. Six months later, someone wondering "why is
  there Chinese in this string match?" reads the pragma reason and
  understands the design.
- Removable without coordinated change: if we later restructure
  `SafetyErrorBanner` to use error codes (no more keyword match),
  deleting the pragma + the CJK string is a single PR.

**Costs**

- Pragma comments appear in diffs and PR previews. Slight visual
  noise in the source; the alternative (allow-list file) trades
  that for the chase-the-import noise.
- The pragma is enforced by the script at the regex level, not
  validated for "is the reason actually a good reason". Bad
  reasons can sneak in if a reviewer doesn't check. Mitigation: the
  three known exception classes are documented in the i18n runbook;
  novel pragma reasons should trigger reviewer pushback.

## Alternatives considered

- **Centralised allowlist file (`scripts/i18n-allowlist.txt`):**
  rejected. The exemption is a property of *that line*, not of the
  string. Centralising creates the "what was this exemption for?"
  problem ADRs are supposed to solve.
- **Block CJK keyword matching entirely, force backend to use
  error codes:** ideal long-term, but P0.4 is a CI hardening pass,
  not a backend protocol redesign. The pragma is a bridge until
  the SafetyErrorBanner backend-protocol cleanup happens.
- **Disable the check on the three offending files:** rejected.
  Coarse-grained; future legitimately-translatable CJK additions
  in `Onboarding.tsx` would silently sneak through.
- **Use `eslint-disable` style comments:** rejected. ESLint pragmas
  are well-known but require ESLint plugin authorship for our
  custom rule. Plain regex pragma is simpler and works in any file
  type.

## How to enforce going forward

- A new pragma is reviewed under the lens: does the literal *belong*
  to one of the three classes (language self-name, protocol keyword,
  seed data written to DB)? If yes, OK. If no, refactor instead.
- Pragmas in `*.test.tsx` are unnecessary because tests are excluded
  from the check by default.
- If the protocol-keyword class grows beyond `SafetyErrorBanner`,
  consider migrating the backend to error codes (eliminate the class)
  rather than expanding pragma usage.

## Related

- `chrono-synth-web/scripts/check-i18n.py` — pragma recognition logic
- `chrono-synth-web/scripts/check-i18n.sh` — shell wrapper around the python check
- PR `chrono-synth-web#19` (P0.4 i18n cleanup + CI gate)
- `.claude/plan/done/p1-c-conversation-layer.md` — same "match against backend
  string" pattern for `value-guard` (which currently doesn't need the pragma
  because guard messages aren't visible to user-facing components)
