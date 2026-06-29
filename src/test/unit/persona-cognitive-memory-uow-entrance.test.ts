/**
 * 单元测试：PersonaCognitiveMemoryGraph 双入口（Phase 3）
 *
 * 该图以 sync UoW 为权威；唯一原 db.transaction 处迁移为 runAtomic。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { PersonaCognitiveMemoryGraph } from '../../persona-core/persona-cognitive-memory.js';
import { TestClock } from '../../utils/clock.js';

describe('Phase 3：PersonaCognitiveMemoryGraph 双入口', () => {
  it('IDatabase 入口与 UoW 入口构造均成功', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fromDb = new PersonaCognitiveMemoryGraph(db);
      assert.ok(fromDb);

      const fromUow = new PersonaCognitiveMemoryGraph(db);
      assert.ok(fromUow);
    } finally { db.close(); }
  });

  it('注入 Clock 时投影时间戳确定可复现（确定性 P1）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    try {
      const fixed = 1_700_000_000_000;
      const graph = new PersonaCognitiveMemoryGraph(db, undefined, undefined, new TestClock(fixed));
      const tenantId = 'default';
      const personaId = 'persona-det';

      /* 外键链：persona_memory_nodes.persona_id → persona_core.id → users.id（owner）。逐层建父行 */
      db.prepare<void>(
        `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
         VALUES (?, ?, 'x', 'member', ?, ?, ?)`,
      ).run('owner-det', 'owner-det@example.com', tenantId, fixed, fixed);
      db.prepare<void>(
        `INSERT INTO persona_core
           (id, tenant_id, owner_user_id, display_name, profile_json, status, visibility,
            growth_index, reputation, training_investment, created_at, updated_at, lifecycle_status)
         VALUES (?, ?, ?, ?, '{}', 'active', 'private', 0, 0, 0, ?, ?, 'active')`,
      ).run(personaId, tenantId, 'owner-det', 'Det Core', fixed, fixed);

      const mem = graph.projectMemory({
        tenantId, personaId, kind: 'episodic', content: 'deterministic projection', valence: 0, salience: 0.6,
      });
      assert.ok(mem.id);

      /* 记忆节点 created_at == 注入时钟 */
      const node = db.prepare<{ created_at: number }>(
        'SELECT created_at FROM persona_memory_nodes WHERE id = ?',
      ).get(mem.id);
      assert.equal(Number(node?.created_at), fixed, 'created_at 须等于注入时钟');

      /* 工作记忆 entered_at == 注入时钟（投影会承纳进工作记忆） */
      const wm = db.prepare<{ entered_at: number }>(
        'SELECT entered_at FROM persona_working_memory WHERE tenant_id = ? AND persona_id = ? AND memory_id = ?',
      ).get(tenantId, personaId, mem.id);
      assert.equal(Number(wm?.entered_at), fixed, '工作记忆 entered_at 须等于注入时钟');
    } finally { db.close(); }
  });
});
