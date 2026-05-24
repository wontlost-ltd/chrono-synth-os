#!/usr/bin/env bash
# Sync OS-built vendored packages to the sibling repos.
#
# Why this exists:
#   chrono-synth-web (and possibly chrono-synth-desktop) keep
#   `packages/design-tokens/`, `packages/contracts/`, etc. as in-repo
#   vendor copies so they don't have to pull the OS monorepo as a
#   dependency. Without active sync these copies drift silently — for
#   example, chrono-synth-web/packages/design-tokens/dist only has
#   v1 tokens, while the OS repo introduced v2 months ago. This script
#   makes the OS repo's `dist/` the authoritative source and pushes
#   it into each sibling's vendor location.
#
# Modes:
#   ./scripts/sync-vendored-packages.sh              # copy
#   ./scripts/sync-vendored-packages.sh --check      # exit 1 on drift
#
# Sibling repo paths follow the same env override convention as
# ga:check (CHRONO_WEB_REPO / CHRONO_DESKTOP_REPO). Missing siblings
# are reported as skipped, not failed (unless --require-siblings).
#
# Limitations:
#   - rsync-style "what's in the source must be in the target"
#     comparison. Files only in the target (e.g. a sibling repo's
#     local additions) are left alone, but they will not survive
#     into the next sync if the source doesn't have them.
#   - Only syncs `dist/` and `package.json` — not `src/`. The vendor
#     contract is "consume the built output", not "we ship sources".

set -euo pipefail

OS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOS_ROOT="$(cd "$OS_ROOT/.." && pwd)"

WEB_ROOT="${CHRONO_WEB_REPO:-$REPOS_ROOT/chrono-synth-web}"
DESKTOP_ROOT="${CHRONO_DESKTOP_REPO:-$REPOS_ROOT/chrono-synth-desktop}"
REQUIRE_SIBLINGS="${CHRONO_GA_REQUIRE_SIBLINGS:-0}"

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --require-siblings) REQUIRE_SIBLINGS=1 ;;
  esac
done

# Each entry: SRC_PKG_DIR  TARGET_REPO  TARGET_PKG_DIR_REL  REQUIRED?
#
# `REQUIRED?` is 1 if the sibling MUST already have this vendor
# location (i.e. the sibling actively imports it), 0 if it's safe
# to skip when the sibling doesn't even have a directory there yet.
SYNC_TASKS=(
  "packages/design-tokens|$WEB_ROOT|packages/design-tokens|1"
  # Desktop doesn't currently vendor design-tokens; left commented out
  # so the script doesn't write a new vendor location surreptitiously.
  # Uncomment + add to desktop/package.json when desktop wants TS-level
  # access to the tokens (CSS-only access works via codegen alone).
  # "packages/design-tokens|$DESKTOP_ROOT|vendor/design-tokens|0"
)

total_changed=0
total_skipped=0
total_errors=0

for task in "${SYNC_TASKS[@]}"; do
  IFS='|' read -r src_rel target_repo target_rel required <<< "$task"
  src="$OS_ROOT/$src_rel"
  target="$target_repo/$target_rel"
  rel_label="$(basename "$target_repo")/$target_rel"

  # Sibling repo missing entirely.
  if [[ ! -d "$target_repo" ]]; then
    if [[ "$REQUIRE_SIBLINGS" == "1" ]]; then
      echo "✖ sibling repo missing (strict): $target_repo"
      total_errors=$((total_errors + 1))
    else
      echo "· skipped (sibling absent): $rel_label"
      total_skipped=$((total_skipped + 1))
    fi
    continue
  fi

  # Sibling has the repo but not the vendor location.
  if [[ ! -d "$target" ]]; then
    if [[ "$required" == "1" ]]; then
      echo "✖ vendor location missing: $rel_label (required)"
      total_errors=$((total_errors + 1))
    else
      echo "· skipped (vendor location absent, not required): $rel_label"
      total_skipped=$((total_skipped + 1))
    fi
    continue
  fi

  # Source `dist/` must exist (caller should run `npm run build` first).
  if [[ ! -d "$src/dist" ]]; then
    echo "✖ source dist missing — run \`npm run build\` first: $src/dist"
    total_errors=$((total_errors + 1))
    continue
  fi

  if [[ "$CHECK_ONLY" == "1" ]]; then
    # diff returns non-zero on any difference. `-rq` = recursive, brief.
    # mktemp avoids the predictable `/tmp/foo.$$` naming pattern, which
    # is benign in CI but a symlink-attack vector on shared hosts.
    diff_file="$(mktemp -t sync-vendored-diff.XXXXXX)"
    if diff -rq "$src/dist" "$target/dist" > "$diff_file" 2>&1; then
      echo "✓ in sync: $rel_label"
    else
      echo "✖ DRIFT: $rel_label"
      sed 's|^|    |' "$diff_file" | head -10
      total_errors=$((total_errors + 1))
    fi
    rm -f "$diff_file"

    # Also compare package.json (a vendor `package.json` change is the
    # main signal a vendor consumer needs to re-check its exports map).
    if ! diff -q "$src/package.json" "$target/package.json" > /dev/null 2>&1; then
      echo "✖ DRIFT: $rel_label/package.json"
      total_errors=$((total_errors + 1))
    fi
    continue
  fi

  # Write mode.
  rm -rf "$target/dist"
  cp -R "$src/dist" "$target/dist"
  cp "$src/package.json" "$target/package.json"
  echo "✓ synced: $rel_label"
  total_changed=$((total_changed + 1))
done

echo ""
echo "changed=$total_changed skipped=$total_skipped errors=$total_errors"

if [[ "$total_errors" -gt 0 ]]; then
  exit 1
fi
exit 0
