/**
 * 单元测试：persona-core-service 双入口（Phase 2 批次 5 验收）
 *
 * 该 service 含 23 处 db.transaction，迁移为 runAtomic（IDatabase 路径走 db.transaction，
 * UoW 路径内联执行交由外层事务处理）。审计/可观测调用在 UoW 模式下静默跳过。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import type { IDatabase } from '../../storage/database.js';

function seedUser(db: IDatabase, userId: string, email: string, tenantId = 'default'): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, 'hash', 'admin', ?, ?, ?)`,
  ).run(userId, email, tenantId, now, now);
}

describe('Phase 2 批次 5：persona-core-service 双入口', () => {
  it('fromUnitOfWork：createPersona 走原子事务', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      seedUser(db, 'u1', 'u1@x.com');
      const fromDb = PersonaCoreService.fromUnitOfWork(db);
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

  it('fromResolver：createPersona 落对应 db（persona_core + memory 行同一 db）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      seedUser(db, 'u1', 'u1@x.com', 't1');
      const svc = PersonaCoreService.fromResolver(new SingleDbResolver(db));
      const persona = svc.createPersona({
        tenantId: 't1',
        ownerUserId: 'u1',
        displayName: 'P1',
        profile: {},
        visibility: 'private',
        initialKnowledge: [{ title: 'K1', content: 'C1', source: 'seed', confidence: 0.8 }],
      });
      assert.ok(persona.id.startsWith('pcore_'));
      /* persona_core 行落 db */
      assert.ok(db.prepare<{ id: string }>('SELECT id FROM persona_core WHERE tenant_id=? AND id=?').get('t1', persona.id));
      /* 跨子服务事务：memory 行也落同一 db（初始知识同步写了一条 memory） */
      const memRow = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM persona_memories WHERE tenant_id=? AND persona_id=?').get('t1', persona.id);
      assert.ok((memRow?.n ?? 0) >= 1);
    } finally { db.close(); }
  });

  it('fromResolver：getCognitive 透传 UoW', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const svc = PersonaCoreService.fromResolver(new SingleDbResolver(db));
      const graph = (svc as unknown as { getCognitive: (t: string) => unknown }).getCognitive('default');
      assert.ok(graph);
    } finally { db.close(); }
  });

  it('fromUnitOfWork：读路径与写路径共用同一 db', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      seedUser(db, 'u1', 'u1@x.com');
      const fromDb = PersonaCoreService.fromUnitOfWork(db);
      const persona = fromDb.createPersona({
        tenantId: 'default',
        ownerUserId: 'u1',
        displayName: 'P1',
        profile: {},
        visibility: 'private',
      });
      const fromUow = PersonaCoreService.fromUnitOfWork(db);
      const detail = fromUow.getPersonaDetail('default', 'u1', persona.id);
      assert.equal(detail?.id, persona.id);
    } finally { db.close(); }
  });
});
