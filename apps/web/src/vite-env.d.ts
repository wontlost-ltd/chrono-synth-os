/// <reference types="vite/client" />

interface Window {
  __CHRONO_RUNTIME_CONFIG__?: {
    apiBaseUrl?: string;
    sentryDsn?: string;
    environment?: string;
  };
}
