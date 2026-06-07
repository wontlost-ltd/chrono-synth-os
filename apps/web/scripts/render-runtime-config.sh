#!/bin/sh
set -eu

OUTPUT_PATH="${RUNTIME_CONFIG_OUTPUT:-./dist/runtime-config.js}"
API_BASE_URL="${CHRONO_WEB_API_BASE_URL:-${VITE_API_BASE_URL:-}}"
SENTRY_DSN="${CHRONO_WEB_SENTRY_DSN:-${VITE_SENTRY_DSN:-}}"
ENVIRONMENT="${CHRONO_WEB_ENVIRONMENT:-production}"

mkdir -p "$(dirname "$OUTPUT_PATH")"

escape_js() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

cat > "$OUTPUT_PATH" <<EOF
window.__CHRONO_RUNTIME_CONFIG__ = Object.freeze({
  apiBaseUrl: "$(escape_js "$API_BASE_URL")",
  sentryDsn: "$(escape_js "$SENTRY_DSN")",
  environment: "$(escape_js "$ENVIRONMENT")"
});
EOF

printf '[render-runtime-config] Wrote %s\n' "$OUTPUT_PATH"
