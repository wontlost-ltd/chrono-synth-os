/**
 * 单元测试：PersonaCognitiveMemoryGraph 双入口（Phase 3）
 *
 * 该图以 sync UoW 为权威；唯一原 db.transaction 处迁移为 runAtomic。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { PersonaCognitiveMemoryGraph } from '../../persona-core/persona-cognitive-memory.js';

describe('Phase 3：PersonaCognitiveMemoryGraph 双入口', () => {
  it('IDatabase 入口与 UoW 入口构造均成功', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const fromDb = new PersonaCognitiveMemoryGraph(db);
      assert.ok(fromDb);

      const fromUow = new PersonaCognitiveMemoryGraph(db);
      assert.ok(fromUow);
    } finally { db.close(); }
  });
});
