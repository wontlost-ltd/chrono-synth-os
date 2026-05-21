/**
 * P0-D #1 — JWT KeyRing lifecycle (active/grace/retired/compromised)
 *               + emergency rotate endpoint + JTI deny-list.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §2.2 P0-D + §8 #4
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { loadConfig } from '../../config/schema.js';
import { KeyRing, type JwtKeyEntry } from '../../server/plugins/jwt-keyring.js';
import { createJtiDenyList } from '../../server/plugins/jwt-deny-list.js';
import type { FastifyInstance } from 'fastify';

function rsa(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { priv: privateKey as string, pub: publicKey as string };
}

function entry(kid: string, state: JwtKeyEntry['state'], rsaPair?: { priv: string; pub: string }): JwtKeyEntry {
  const k = rsaPair ?? rsa();
  return {
    kid, state, algorithm: 'RS256',
    privateKey: state === 'active' ? k.priv : '',
    publicKey: k.pub,
    secret: '',
  };
}

describe('P0-D #1 — KeyRing unit invariants', () => {
  it('rejects construction without exactly 1 active', () => {
    assert.throws(() => new KeyRing([]), /exactly 1 active key required, got 0/);
    assert.throws(() => new KeyRing([
      entry('k1', 'grace'),
      entry('k2', 'grace'),
    ]), /exactly 1 active key required, got 0/);
    assert.throws(() => new KeyRing([
      entry('k1', 'active'),
      entry('k2', 'active'),
    ]), /exactly 1 active key required, got 2/);
  });

  it('rejects duplicate kids', () => {
    assert.throws(() => new KeyRing([
      entry('dup', 'active'),
      entry('dup', 'grace'),
    ]), /duplicate kid/);
  });

  it('verifyEntry returns undefined for retired/compromised/unknown', () => {
    const k1 = rsa(); const k2 = rsa(); const k3 = rsa();
    const ring = new KeyRing([
      entry('active-k', 'active', k1),
      entry('grace-k', 'grace', k2),
      entry('retired-k', 'retired', k3),
    ]);
    assert.ok(ring.verifyEntry('active-k'));
    assert.ok(ring.verifyEntry('grace-k'));
    assert.equal(ring.verifyEntry('retired-k'), undefined);
    assert.equal(ring.verifyEntry('unknown-k'), undefined);
    assert.equal(ring.verifyEntry(undefined), undefined);
  });

  it('signEntry always returns the active key', () => {
    const ring = new KeyRing([entry('a', 'active'), entry('b', 'grace')]);
    assert.equal(ring.signEntry().kid, 'a');
  });

  it('publishedEntries returns active + grace only', () => {
    const ring = new KeyRing([
      entry('a', 'active'),
      entry('b', 'grace'),
      entry('c', 'retired'),
      entry('d', 'compromised'),
    ]);
    const kids = ring.publishedEntries().map(e => e.kid).sort();
    assert.deepEqual(kids, ['a', 'b']);
  });

  it('rotate transitions previous active to grace by default', () => {
    const newPair = rsa();
    const ring = new KeyRing([entry('a', 'active')]);
    ring.rotate({ newActiveKid: 'b', addNew: [entry('b', 'grace', newPair)] });
    assert.equal(ring.activeKid(), 'b');
    assert.equal(ring.get('a')?.state, 'grace');
    assert.equal(ring.get('b')?.state, 'active');
  });

  it('rotate refuses to compromise the active key', () => {
    const ring = new KeyRing([entry('a', 'active'), entry('b', 'grace')]);
    assert.throws(() => ring.markCompromised('a'), /refusing to compromise the active key/);
    /* But OK after rotating away */
    ring.rotate({ newActiveKid: 'b' });
    assert.doesNotThrow(() => ring.markCompromised('a'));
    assert.equal(ring.get('a')?.state, 'compromised');
    assert.equal(ring.verifyEntry('a'), undefined);
  });
});

describe('P0-D #1 — JTI deny-list', () => {
  it('denies a jti within its expiry', () => {
    const dl = createJtiDenyList();
    dl.deny('jti-1', Date.now() + 60_000);
    assert.equal(dl.isDenied('jti-1'), true);
  });

  it('expires entries after expiresAtMs', () => {
    const dl = createJtiDenyList();
    dl.deny('jti-1', Date.now() - 1);  /* already expired */
    assert.equal(dl.isDenied('jti-1'), false);
  });

  it('ignores empty jti', () => {
    const dl = createJtiDenyList();
    assert.equal(dl.isDenied(''), false);
    dl.deny('', Date.now() + 60_000);  /* no-op */
    assert.equal(dl.size(), 0);
  });

  it('LRU evicts oldest when full', () => {
    const dl = createJtiDenyList(2);
    const t = Date.now() + 60_000;
    dl.deny('a', t);
    dl.deny('b', t);
    dl.deny('c', t);
    /* 'a' should have been evicted */
    assert.equal(dl.isDenied('a'), false);
    assert.equal(dl.isDenied('b'), true);
    assert.equal(dl.isDenied('c'), true);
  });
});

describe('P0-D #1 — Integration: multi-kid app + rotate endpoint', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let oldKid: string;
  let oldPair: { priv: string; pub: string };

  before(async () => {
    oldPair = rsa();
    const config = loadConfig({
      rateLimit: { max: 10000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: {
        enabled: true,
        algorithm: 'RS256',
        secret: 'change-me-in-production',  /* unused in asym multi-key */
        issuer: 'test-multi-kid-issuer',
        keys: [{
          kid: 'kid-1',
          state: 'active',
          algorithm: 'RS256',
          privateKey: oldPair.priv,
          publicKey: oldPair.pub,
          secret: '',
        }],
      },
    });
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
    oldKid = (app as unknown as { jwtKid: string }).jwtKid;
  });

  after(async () => { await app.close(); os.close(); });

  it('initial active kid matches jwt.keys', () => {
    assert.equal(oldKid, 'kid-1');
  });

  it('JWKS publishes the active key', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const body = JSON.parse(res.body) as { keys: Array<{ kid: string; alg: string }> };
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0]!.kid, 'kid-1');
  });

  it('register + login under multi-kid works (active key signs)', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'multi-kid-1@example.com', password: 'password123' },
    });
    assert.ok(reg.statusCode >= 200 && reg.statusCode < 300,
      `register ${reg.statusCode}: ${reg.body}`);
    const parsed = JSON.parse(reg.body);
    assert.equal(typeof parsed.data?.accessToken, 'string',
      `register body data.accessToken not string. body=${reg.body}`);
    const accessToken = parsed.data.accessToken as string;
    const header = JSON.parse(Buffer.from(accessToken.split('.')[0]!, 'base64url').toString('utf-8'));
    assert.equal(header.kid, 'kid-1');
  });

  it('non-admin POST /api/v1/auth/keys/rotate is rejected', async () => {
    /* Auth service defaults new users to 'admin' role (P0-D #1 limitation —
     * see auth-service.ts:77). Downgrade to viewer to test the role guard. */
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'non-admin@example.com', password: 'password123' },
    });
    assert.ok(reg.statusCode >= 200 && reg.statusCode < 300, `register: ${reg.statusCode} ${reg.body}`);
    const parsedReg = JSON.parse(reg.body);
    const userId = parsedReg.data.userId as string;
    const db = (os as unknown as { getDatabase(): { prepare(s: string): { run(...args: unknown[]): unknown } } }).getDatabase();
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('viewer', userId);

    /* Re-login to refresh role claim in JWT. */
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'non-admin@example.com', password: 'password123' },
    });
    assert.ok(login.statusCode >= 200 && login.statusCode < 300, `login: ${login.statusCode} ${login.body}`);
    const accessToken = JSON.parse(login.body).data.accessToken as string;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/keys/rotate',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { newActiveKid: 'whatever' },
    });
    assert.equal(res.statusCode, 403, `expected 403 not ${res.statusCode}: ${res.body}`);
  });

  it('admin POST /api/v1/auth/keys/rotate refuses signing-key change with 409 RESTART_REQUIRED', async () => {
    /* After the dual code review, the rotate endpoint refuses any rotation
     * that would shift the signing-effective active kid. This is the
     * correct contract: fastify-jwt captures its signer at register() time;
     * silently moving "active" while continuing to sign with the old key
     * would publish a JWKS the server cannot honour, breaking every newly
     * issued token at client verification. Operators must update jwt.keys
     * config and restart instead. */
    const newPair = rsa();
    const db = (os as unknown as { getDatabase(): { prepare(s: string): { run(...args: unknown[]): unknown } } }).getDatabase();
    db.prepare(`UPDATE users SET role = 'admin' WHERE email = 'multi-kid-1@example.com'`).run();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'multi-kid-1@example.com', password: 'password123' },
    });
    assert.ok(login.statusCode >= 200 && login.statusCode < 300, `login: ${login.statusCode} ${login.body}`);
    const adminToken = JSON.parse(login.body).data.accessToken as string;

    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/keys/rotate',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        newActiveKid: 'kid-2',
        addNew: [{
          kid: 'kid-2', state: 'grace', algorithm: 'RS256',
          privateKey: newPair.priv, publicKey: newPair.pub, secret: '',
        }],
      },
    });
    assert.equal(rotate.statusCode, 409, `expected 409 RESTART_REQUIRED, got ${rotate.statusCode}: ${rotate.body}`);
    const body = JSON.parse(rotate.body) as { code: string; bootActiveKid: string; requestedNewActiveKid: string };
    assert.equal(body.code, 'AUTH_ROTATE_RESTART_REQUIRED');
    assert.equal(body.bootActiveKid, 'kid-1');
    assert.equal(body.requestedNewActiveKid, 'kid-2');
  });

  it('admin POST /api/v1/auth/keys/rotate ACCEPTS a no-op rotate that only changes oldActiveNewState', async () => {
    /* The legitimate Phase-1A use case: mark the current active key's state
     * (rotate where newActiveKid === current active, no signing change).
     * This is useful for adjusting grace/retired metadata without restart. */
    const db = (os as unknown as { getDatabase(): { prepare(s: string): { run(...args: unknown[]): unknown } } }).getDatabase();
    db.prepare(`UPDATE users SET role = 'admin' WHERE email = 'multi-kid-1@example.com'`).run();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'multi-kid-1@example.com', password: 'password123' },
    });
    const adminToken = JSON.parse(login.body).data.accessToken as string;

    /* No-op rotate: newActiveKid = bootActiveKid (kid-1). */
    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/keys/rotate',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { newActiveKid: 'kid-1' },
    });
    assert.ok(rotate.statusCode >= 200 && rotate.statusCode < 300, `rotate: ${rotate.statusCode} ${rotate.body}`);
    const body = JSON.parse(rotate.body) as {
      activeKid: string;
      snapshot: { active: { kid: string; hasPrivateKey: boolean; hasPublicKey: boolean } };
    };
    assert.equal(body.activeKid, 'kid-1');
    /* SECURITY: the rotate response must NEVER contain raw key material.
     * snapshot is a JwtKeyView (kid/state/algorithm/has{Private,Public}Key)
     * only — privateKey/publicKey/secret never leave KeyRing. */
    const serialised = rotate.body;
    assert.ok(!serialised.includes('-----BEGIN'),
      'rotate response leaked PEM key material');
    assert.ok(!serialised.includes('"privateKey"'),
      'rotate response leaked privateKey field');
    assert.ok(!serialised.includes('"secret"'),
      'rotate response leaked secret field');
    /* The view has the redaction-safe boolean flags instead. */
    assert.equal(typeof body.snapshot.active.hasPrivateKey, 'boolean');
    assert.equal(typeof body.snapshot.active.hasPublicKey, 'boolean');
  });
});

describe('P0-D #1 — Compromised kid rejection (isolated app)', () => {
  /* Separate describe with own app instance so mutating the KeyRing
   * (markCompromised) doesn't bleed into the other integration tests. */
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  before(async () => {
    const pair = rsa();
    const config = loadConfig({
      rateLimit: { max: 10000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: {
        enabled: true,
        algorithm: 'RS256',
        secret: 'change-me-in-production',
        issuer: 'test-compromise-issuer',
        keys: [{
          kid: 'compromise-boot-kid',
          state: 'active',
          algorithm: 'RS256',
          privateKey: pair.priv,
          publicKey: pair.pub,
          secret: '',
        }],
      },
    });
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config });
  });

  after(async () => { await app.close(); os.close(); });

  it('token signed under compromised kid → onRequest returns 401 AUTH_KID_REVOKED', async () => {
    /* 1. Register a user → get a token signed with boot kid. */
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'compromise-target@example.com', password: 'password123' },
    });
    assert.ok(reg.statusCode >= 200 && reg.statusCode < 300, `register: ${reg.statusCode}`);
    const accessToken = JSON.parse(reg.body).data.accessToken as string;
    const tokenKid = JSON.parse(Buffer.from(accessToken.split('.')[0]!, 'base64url').toString('utf-8')).kid as string;

    /* 2. Sanity: token verifies under current ring. */
    const okBefore = await app.inject({
      method: 'GET', url: '/api/v1/audit-trail',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.ok(okBefore.statusCode !== 401, `pre-compromise should pass, got ${okBefore.statusCode}`);

    /* 3. Rotate away from the current active kid, then mark it compromised. */
    const ring = (app as unknown as { jwtKeyRing: KeyRing }).jwtKeyRing;
    const newPair = rsa();
    ring.rotate({
      newActiveKid: 'replacement-kid',
      addNew: [{
        kid: 'replacement-kid', state: 'grace', algorithm: 'RS256',
        privateKey: newPair.priv, publicKey: newPair.pub, secret: '',
      }],
    });
    ring.markCompromised(tokenKid);

    /* 4. Token signed under compromised kid must now be rejected by the
     *    KeyRing layer in onRequest (defence in depth — the static
     *    cryptographic key would still verify, but our layer denies). */
    const afterCompromise = await app.inject({
      method: 'GET', url: '/api/v1/audit-trail',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(afterCompromise.statusCode, 401,
      `compromised-kid token must be 401, got ${afterCompromise.statusCode}: ${afterCompromise.body}`);
    const errBody = JSON.parse(afterCompromise.body) as { code?: string };
    assert.equal(errBody.code, 'AUTH_KID_REVOKED');
  });

  it('JWKS does not publish compromised kids', async () => {
    /* From the prior test, the boot kid is now compromised; only the
     * replacement (active) remains published. */
    const jwks = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const body = JSON.parse(jwks.body) as { keys: Array<{ kid: string }> };
    const kids = body.keys.map(k => k.kid);
    assert.ok(!kids.includes('compromise-boot-kid'), 'compromised kid must not be in JWKS');
    assert.ok(kids.includes('replacement-kid'), 'active replacement kid should be in JWKS');
  });
});
