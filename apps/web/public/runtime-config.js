/* Empty default — production deployments overwrite this file via init
 * container or build-time substitution to inject environment-specific
 * settings (otelTraceEndpoint, environment, otelDisable, etc.).
 *
 * Shipping the file ensures /runtime-config.js never 404s in dev or
 * preview builds; readers in src/lib/tracing.ts already treat the
 * config as optional. */
window.__CHRONO_RUNTIME_CONFIG__ = window.__CHRONO_RUNTIME_CONFIG__ || {};
