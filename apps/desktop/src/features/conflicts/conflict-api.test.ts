/**
 * conflict-api tests — focus on the HTTP status parser.
 *
 * Why it matters: ConflictDetail.classifyError() routes 409 to the
 * stale-refresh path and other 4xx to the user-visible error path.
 * Misclassifying 400/401/403/404 as "stale" would silently swallow
 * real failures and ping-pong the list. Lock the parser semantics
 * with explicit cases.
 */

import { describe, it, expect } from 'vitest';
import { getHttpStatus } from './conflict-api';

describe('getHttpStatus', () => {
  it('extracts numeric status from apiFetch-style "HTTP NNN: body" messages', () => {
    expect(getHttpStatus(new Error('HTTP 409: Conflict version mismatch'))).toBe(409);
    expect(getHttpStatus(new Error('HTTP 400: bad payload'))).toBe(400);
    expect(getHttpStatus(new Error('HTTP 401'))).toBe(401);
    expect(getHttpStatus(new Error('HTTP 503: upstream down'))).toBe(503);
  });

  it('returns null when the message does not start with HTTP NNN', () => {
    expect(getHttpStatus(new Error('Network request failed'))).toBeNull();
    expect(getHttpStatus(new Error('TypeError: undefined is not a function'))).toBeNull();
    /* Substring matches must not count — only prefix. */
    expect(getHttpStatus(new Error('Saw HTTP 409 in logs but not the actual error'))).toBeNull();
  });

  it('returns null for non-Error values (string, undefined, object)', () => {
    expect(getHttpStatus('HTTP 409')).toBeNull();
    expect(getHttpStatus(undefined)).toBeNull();
    expect(getHttpStatus(null)).toBeNull();
    expect(getHttpStatus({ status: 409 })).toBeNull();
  });
});
