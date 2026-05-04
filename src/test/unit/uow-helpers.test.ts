/**
 * 单元测试：UoW 共享辅助（Phase 2 批次 1）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runMigrations } from '../../storage/migrations.js';
import { directUnitOfWork } from '../../storage/direct-uow-adapter.js';
import { asUow, isUow, unwrapDb } from '../../storage/uow-helpers.js';

describe('uow-helpers', () => {
  it('isUow 区分 IDatabase 与 SyncWriteUnitOfWork', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      assert.equal(isUow(db), false);
      const uow = directUnitOfWork(db);
      assert.equal(isUow(uow), true);
    } finally {
      db.close();
    }
  });

  it('asUow 透传 SyncWriteUnitOfWork', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const uow = directUnitOfWork(db);
      assert.equal(asUow(uow), uow);
    } finally {
      db.close();
    }
  });

  it('asUow 把 IDatabase 包装为 SyncWriteUnitOfWork', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      const tx = asUow(db);
      assert.equal(typeof tx.queryOne, 'function');
      assert.equal(typeof tx.queryMany, 'function');
      assert.equal(typeof tx.execute, 'function');
    } finally {
      db.close();
    }
  });

  it('unwrapDb 仅在 IDatabase 形态下返回底层连接', () => {
    const db = createMemoryDatabase();
    runMigrations(db);
    try {
      assert.equal(unwrapDb(db), db);
      const uow = directUnitOfWork(db);
      assert.equal(unwrapDb(uow), null);
    } finally {
      db.close();
    }
  });
});
