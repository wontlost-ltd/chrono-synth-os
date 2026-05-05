/**
 * 单元测试：GoogleOauthFlow（F2）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleOauthFlow } from '../../agent/oauth-google-flow.js';
import { ValidationError } from '../../errors/index.js';

const baseConfig = {
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri: 'https://app.example/callback',
};

describe('GoogleOauthFlow', () => {
  it('构造器在缺失字段时抛 ValidationError', () => {
    assert.throws(() => new GoogleOauthFlow({ clientId: '', clientSecret: '', redirectUri: '' }), ValidationError);
  });

  it('buildAuthorizeUrl 包含必备参数', () => {
    const flow = new GoogleOauthFlow(baseConfig);
    const url = flow.buildAuthorizeUrl({
      scope: 'https://www.googleapis.com/auth/calendar',
      state: 'a'.repeat(32),
    });
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(parsed.searchParams.get('client_id'), 'cid');
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.equal(parsed.searchParams.get('access_type'), 'offline');
    assert.equal(parsed.searchParams.get('prompt'), 'consent');
    assert.equal(parsed.searchParams.get('state'), 'a'.repeat(32));
    assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app.example/callback');
  });

  it('buildAuthorizeUrl 在 state 过短时抛错', () => {
    const flow = new GoogleOauthFlow(baseConfig);
    assert.throws(
      () => flow.buildAuthorizeUrl({ scope: 's', state: 'short' }),
      ValidationError,
    );
  });

  it('exchangeCodeForToken/refreshAccessToken 使用 fetch 调 token endpoint', async () => {
    const flow = new GoogleOauthFlow(baseConfig);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: 'new_a',
      refresh_token: 'new_r',
      expires_in: 1800,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/calendar',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      const r1 = await flow.exchangeCodeForToken('code123');
      assert.equal(r1.accessToken, 'new_a');
      assert.equal(r1.refreshToken, 'new_r');
      assert.equal(r1.tokenType, 'Bearer');
      assert.ok(r1.accessExpiresAt > Date.now());

      const r2 = await flow.refreshAccessToken('rfsh');
      /* refresh 不变时回退到入参 */
      assert.equal(r2.refreshToken, 'new_r');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refreshAccessToken 在响应无 refresh_token 时回退到入参', async () => {
    const flow = new GoogleOauthFlow(baseConfig);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: 'a2',
      expires_in: 100,
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const r = await flow.refreshAccessToken('original_refresh');
      assert.equal(r.refreshToken, 'original_refresh');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
