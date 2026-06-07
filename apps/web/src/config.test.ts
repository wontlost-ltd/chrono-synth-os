import { describe, expect, it } from 'vitest';
import { resolveRuntimeConfig } from './config';

describe('resolveRuntimeConfig', () => {
  it('prefers runtime window config over build-time env', () => {
    const config = resolveRuntimeConfig(
      {
        window: {
          __CHRONO_RUNTIME_CONFIG__: {
            apiBaseUrl: 'https://api.runtime.test',
            sentryDsn: 'https://dsn.runtime.test/1',
            environment: 'production',
          },
        },
      },
      {
        VITE_API_BASE_URL: 'https://api.build.test',
        VITE_SENTRY_DSN: 'https://dsn.build.test/1',
        MODE: 'staging',
      },
    );

    expect(config).toEqual({
      apiBaseUrl: 'https://api.runtime.test',
      sentryDsn: 'https://dsn.runtime.test/1',
      environment: 'production',
    });
  });

  it('falls back to build-time env when runtime config is absent', () => {
    const config = resolveRuntimeConfig(
      {},
      {
        VITE_API_BASE_URL: 'https://api.build.test',
        VITE_SENTRY_DSN: 'https://dsn.build.test/1',
        MODE: 'staging',
      },
    );

    expect(config).toEqual({
      apiBaseUrl: 'https://api.build.test',
      sentryDsn: 'https://dsn.build.test/1',
      environment: 'staging',
    });
  });
});
