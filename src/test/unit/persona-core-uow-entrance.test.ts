/**
 * 单元测试：persona-core-service 双入口（Phase 2 批次 5 验收）
 *
 * 该 service 含 23 处 db.transaction，迁移为 runAtomic（IDatabase 路径走 db.transaction，
 * UoW 路径内联执行交由外层事务处理）。审计/可观测调用在 UoW 模式下静默跳过。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { IDatabase } from '../../storage/database.js';

function seedUser(db: IDatabase, userId: string, email: string, tenantId = 'default'): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, 'hash', 'admin', ?, ?, ?)`,
  ).run(userId, email, tenantId, now, now);
}

describe('Phase 2 批次 5：persona-core-service 双入口', () => {
  it('createPersona 双入口：IDatabase 路径走原子事务', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      seedUser(db, 'u1', 'u1@x.com');
      const fromDb = new PersonaCoreService(db);
      const persona = fromDb.createPersona({
        tenantId: 'default',
        ownerUserId: 'u1',
        displayName: 'P1',
        profile: { templateId: 'b' },
        visibility: 'private',
      });
      assert.ok(persona.id.startsWith('pcore_'));

      const list = fromDb.listPersonas('default', 'u1');
      assert.equal(list.length, 1);
    } finally { db.close(); }
  });

  it('UoW 入口：getCognitive 现已透传 UoW（Phase 3 解锁）', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromUow = new PersonaCoreService(directUnitOfWork(db));
      const graph = (fromUow as unknown as { getCognitive: (t: string) => unknown }).getCognitive('default');
      assert.ok(graph);
    } finally { db.close(); }
  });

  it('UoW 入口：审计/可观测调用静默跳过', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      seedUser(db, 'u1', 'u1@x.com');
      const fromDb = new PersonaCoreService(db);
      const persona = fromDb.createPersona({
        tenantId: 'default',
        ownerUserId: 'u1',
        displayName: 'P1',
        profile: {},
        visibility: 'private',
      });
      const fromUow = new PersonaCoreService(directUnitOfWork(db));
      const detail = fromUow.getPersonaDetail('default', 'u1', persona.id);
      assert.equal(detail?.id, persona.id);
    } finally { db.close(); }
  });
});
