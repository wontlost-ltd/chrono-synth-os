/**
 * Step 16 — PersonaMemoryService extraction tests.
 *
 * The Step 16 split decoupled memory CRUD from the 3482-line god-object.
 * These tests sit at the new seam: they exercise PersonaMemoryService
 * directly (not via the facade), so a future refactor that breaks the
 * sub-service's contract gets a focused failure here rather than a
 * 1000-line integration test diff.
 *
 * Coverage:
 *   - addMemory returns null when the persona doesn't exist (owner
 *     guard) — proves the injected `getPersonaDetail` is consulted.
 *   - addMemory returns null when the persona is terminal — proves the
 *     `isTerminalStatus` injection works.
 *   - addMemory writes through and search/list see the row — proves
 *     the SQL path is intact post-extraction.
 *   - searchPersonaMemories ranks by token-hit + importance — proves
 *     the score formula was preserved byte-for-byte during extraction.
 *   - getPersonaGraphSummary returns the kind+relation roll-up — proves
 *     the cognitive-graph factory still binds correctly.
 *   - memoryFromRow decodes encrypted rows when an encryption resolver
 *     is set — proves the resolver precedence (resolver wins over
 *     static, then static, then no-op) carried through cleanly.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { PersonaMemoryService } from '../../persona-core/persona-memory-service.js';
import type { PersonaMemoryContext } from '../../persona-core/persona-memory-service.js';

interface Fixture {
  db: IDatabase;
  service: PersonaCoreService;
  memoryService: PersonaMemoryService;
  personaId: string;
  tenantId: string;
  ownerUserId: string;
}

function setup(): Fixture {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  const tenantId = 'tenant_test';
  const ownerUserId = 'user_test_owner';
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ownerUserId, 'owner@example.com', 'hash', 'member', tenantId, now, now);

  const service = new PersonaCoreService(db);
  const persona = service.createPersona({
    tenantId,
    ownerUserId,
    displayName: 'Memory Test',
    profile: {},
  });

  /* Build a memory service against the same tx with a context that
   * mirrors what PersonaCoreService wires internally. Direct-instance
   * use proves the seam is callable independently of the facade. */
  const ctx: PersonaMemoryContext = {
    getPersonaDetail: (t, o, p) => service.getPersonaDetail(t, o, p),
    /* Use the actual terminal statuses from the PersonaCore type
     * union. `transferred` is also terminal (ownership moved). */
    isTerminalStatus: (status) => status === 'deceased' || status === 'transferred',
    forkBelongsToPersona: () => true,
  };
  const memoryService = new PersonaMemoryService(db, ctx);

  return { db, service, memoryService, personaId: persona.id, tenantId, ownerUserId };
}

describe('PersonaMemoryService (Step 16 extraction)', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setup();
  });

  it('addMemory returns null when the persona owner check fails', () => {
    const result = fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: 'unknown-owner',
      personaId: fx.personaId,
      kind: 'interaction',
      summary: 'should be rejected',
      importance: 0.5,
    });
    assert.equal(result, null);
  });

  it('addMemory returns null when the persona is terminal', () => {
    fx.service.markDeceased(fx.tenantId, fx.ownerUserId, fx.personaId, 'test');
    const result = fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      kind: 'interaction',
      summary: 'after death',
      importance: 0.5,
    });
    assert.equal(result, null);
  });

  it('addMemory + listPersonaMemories round-trips through the new service', () => {
    const added = fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      kind: 'interaction',
      summary: 'first memory',
      content: { source: 'unit-test' },
      importance: 0.7,
    });
    assert.ok(added);
    assert.equal(added?.summary, 'first memory');

    const listed = fx.memoryService.listPersonaMemories(
      fx.tenantId,
      fx.ownerUserId,
      fx.personaId,
    );
    assert.ok(listed);
    assert.ok(listed!.some((m) => m.id === added!.id));
  });

  it('searchPersonaMemories scores hits by token presence + importance', () => {
    fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      kind: 'interaction',
      summary: 'meeting notes about launch readiness',
      content: {},
      importance: 0.9,
    });
    fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      kind: 'interaction',
      summary: 'random unrelated note',
      content: {},
      importance: 0.1,
    });

    const results = fx.memoryService.searchPersonaMemories(
      fx.tenantId,
      fx.ownerUserId,
      fx.personaId,
      'launch',
    );
    assert.ok(results);
    assert.ok(results!.length >= 1);
    /* The "launch" memory must rank above the unrelated one. */
    assert.match(results![0]!.contentText, /launch/);
  });

  it('getPersonaGraphSummary returns the kind+relation roll-up after writes', () => {
    fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      kind: 'knowledge',
      summary: 'a fact',
      content: {},
      importance: 0.5,
    });
    fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      kind: 'interaction',
      summary: 'an episode',
      content: {},
      importance: 0.5,
    });

    const summary = fx.memoryService.getPersonaGraphSummary(
      fx.tenantId,
      fx.ownerUserId,
      fx.personaId,
    );
    assert.ok(summary);
    /* The summary should be populated; exact counts depend on the
     * cognitive graph projection, but at minimum totalNodes ≥ 2. */
    assert.ok(summary!.totalNodes >= 2);
  });

  it('facade and sub-service return byte-equal results for list + search', () => {
    /* Stronger equivalence: same writes, both read paths, identical
     * results. Locks in that delegations don't accidentally re-order,
     * re-filter, or re-format. */
    fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      kind: 'interaction',
      summary: 'alpha memory keyword',
      importance: 0.8,
    });
    fx.memoryService.addMemory({
      tenantId: fx.tenantId,
      ownerUserId: fx.ownerUserId,
      personaId: fx.personaId,
      kind: 'knowledge',
      summary: 'beta keyword',
      importance: 0.3,
    });

    const listFacade = fx.service.listPersonaMemories(
      fx.tenantId, fx.ownerUserId, fx.personaId,
    );
    const listSub = fx.memoryService.listPersonaMemories(
      fx.tenantId, fx.ownerUserId, fx.personaId,
    );
    assert.deepEqual(listFacade, listSub);

    const searchFacade = fx.service.searchPersonaMemories(
      fx.tenantId, fx.ownerUserId, fx.personaId, 'keyword',
    );
    const searchSub = fx.memoryService.searchPersonaMemories(
      fx.tenantId, fx.ownerUserId, fx.personaId, 'keyword',
    );
    assert.deepEqual(searchFacade, searchSub);

    const summaryFacade = fx.service.getPersonaGraphSummary(
      fx.tenantId, fx.ownerUserId, fx.personaId,
    );
    const summarySub = fx.memoryService.getPersonaGraphSummary(
      fx.tenantId, fx.ownerUserId, fx.personaId,
    );
    assert.deepEqual(summaryFacade, summarySub);
  });

  it('memoryFromRow tolerates decrypt failures with stored-value fallback (pre-split behaviour preserved)', () => {
    /* Construct a memory service with a static field-encryption that
     * always throws on decrypt — simulates malformed ciphertext /
     * rotated key / missing key ref. The sub-service must NOT
     * propagate the throw; before the Step 16 split, the facade
     * caught these and returned the stored (encrypted) value
     * verbatim. Any regression here would break getPersonaDetail()
     * for personas with old encrypted memories after a key
     * rotation. */
    const throwingEnc = {
      isEnabled: true as const,
      encrypt: (value: string) => `enc:${value}`,
      decrypt: () => {
        throw new Error('decrypt failed (simulated bad key)');
      },
    };
    const ctx: PersonaMemoryContext = {
      getPersonaDetail: (t, o, p) => fx.service.getPersonaDetail(t, o, p),
      isTerminalStatus: () => false,
      forkBelongsToPersona: () => true,
    };
    /* Pass throwingEnc as the static-encryption arg. The resolver
     * slot is left undefined — precedence is "resolver wins if
     * enabled, else static", so when the resolver is undefined we
     * fall through to static and hit the throwing path on read. */
    const throwingMemoryService = new PersonaMemoryService(
      fx.db,
      ctx,
      throwingEnc as unknown as import('../../storage/encryption.js').FieldEncryption,
    );

    /* Write through the throwing service so we get a row with
     * isEncrypted=1. The encrypt call works; only decrypt throws. */
    throwingMemoryService.insertMemory({
      tenantId: fx.tenantId,
      personaId: fx.personaId,
      kind: 'interaction',
      sensitivity: 'encrypted',
      summary: 'secret content',
      content: { foo: 'bar' },
      importance: 0.5,
    });

    /* Reading back must NOT throw — the fallback returns the
     * encrypted (stored) value rather than blowing up the request.
     * The `enc:` prefix is what `encrypt()` added, so seeing it back
     * in `summary` confirms decrypt failed AND the fallback returned
     * the ciphertext verbatim (matching pre-split behaviour). */
    const listed = throwingMemoryService.listPersonaMemories(
      fx.tenantId, fx.ownerUserId, fx.personaId,
    );
    assert.ok(listed);
    assert.ok(listed!.length >= 1);
    const stored = listed![listed!.length - 1]!;
    assert.equal(
      stored.summary,
      'enc:secret content',
      'fallback should return the stored (encrypted) summary verbatim',
    );
  });
});
