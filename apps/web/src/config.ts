export interface RuntimeConfig {
  apiBaseUrl: string;
  sentryDsn: string;
  environment: string;
}

type RuntimeWindow = {
  window?: {
    __CHRONO_RUNTIME_CONFIG__?: Partial<RuntimeConfig>;
  };
};

type BuildEnv = {
  VITE_API_BASE_URL?: string;
  VITE_SENTRY_DSN?: string;
  MODE?: string;
};

export function resolveRuntimeConfig(
  source: RuntimeWindow = globalThis as RuntimeWindow,
  buildEnv: BuildEnv = import.meta.env,
): RuntimeConfig {
  const runtime = source.window?.__CHRONO_RUNTIME_CONFIG__;

  return {
    apiBaseUrl: runtime?.apiBaseUrl ?? buildEnv.VITE_API_BASE_URL ?? '',
    sentryDsn: runtime?.sentryDsn ?? buildEnv.VITE_SENTRY_DSN ?? '',
    environment: runtime?.environment ?? buildEnv.MODE ?? 'production',
  };
}

const runtimeConfig = resolveRuntimeConfig();

/** API 基础 URL — 默认留空，走同源代理 */
export const API_BASE_URL = runtimeConfig.apiBaseUrl;

/** Sentry DSN — 为空时禁用 Sentry */
export const SENTRY_DSN = runtimeConfig.sentryDsn;

export const APP_ENVIRONMENT = runtimeConfig.environment;
