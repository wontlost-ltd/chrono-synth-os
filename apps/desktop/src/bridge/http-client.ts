/**
 * Lightweight HTTP client for talking to a chrono-synth-os instance.
 *
 * The Tauri shell normally runs against a local SQLite via tauri-commands,
 * but agent OAuth + pending-confirmation flows require the HTTP API
 * because they involve external Google redirects and confirmation tokens
 * that live in the server-side conversation_confirmation_tokens table.
 *
 * The base URL and JWT live in localStorage so the user can point this
 * client at their own chrono-synth-os deployment.
 */

const STORAGE_BASE = 'chrono.api.baseUrl';
const STORAGE_TOKEN = 'chrono.api.token';

export function getApiBaseUrl(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_BASE);
}

export function setApiBaseUrl(url: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (url) localStorage.setItem(STORAGE_BASE, url.replace(/\/+$/, ''));
  else localStorage.removeItem(STORAGE_BASE);
}

export function getApiToken(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_TOKEN);
}

export function setApiToken(token: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (token) localStorage.setItem(STORAGE_TOKEN, token);
  else localStorage.removeItem(STORAGE_TOKEN);
}

export class ApiNotConfiguredError extends Error {
  constructor() {
    super('Chrono Synth API not configured. Set base URL + token under Settings.');
    this.name = 'ApiNotConfiguredError';
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const base = getApiBaseUrl();
  const token = getApiToken();
  if (!base || !token) throw new ApiNotConfiguredError();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...((options.headers as Record<string, string>) ?? {}),
  };
  const init: RequestInit = {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
