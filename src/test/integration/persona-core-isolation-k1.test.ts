/**
 * K1（ADR-0056）每-(租户, 人格) 认知内核隔离·数据层验证。
 *
 * 验证 v106 迁移把 persona_id 加进 7 张认知核心表（default 回填）+ 复合索引——数据层能**按 persona_id
 * 列过滤区分多 persona**，且**完全向后兼容**（不改主键/唯一约束，旧 executor `ON CONFLICT(tenant_id)` 仍跑）。
 *
 * 关键设计：主键/唯一约束改 (tenant_id, persona_id) 与 executor 改 ON CONFLICT 必须 K2 原子一起落，K1 只加列。
 * 故这里验：列存在 + 默认回填 + 按列隔离 + 复合索引 + **legacy 单 tenant upsert 不破**。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';

const CORE_TABLES = [
  'decision_style', 'cognitive_model', 'narrative',
  'core_values', 'survival_anchors', 'memory_nodes', 'memory_edges',
] as const;
const SINGLETON_TABLES = ['decision_style', 'cognitive_model', 'narrative'] as const;

interface ColInfo { name: string; pk: number }

describe('K1 ADR-0056 每-(租户,人格) 认知核心隔离·数据层', () => {
  let db: IDatabase;
  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
  });

  const cols = (table: string): ColInfo[] =>
    db.prepare<ColInfo>(`PRAGMA table_info(${table})`).all();

  it('★所有 7 张认知核心表都有 persona_id 列★', () => {
    for (const t of CORE_TABLES) {
      const names = cols(t).map((c) => c.name);
      assert.ok(names.includes('persona_id'), `${t} 缺 persona_id`);
      assert.ok(names.includes('tenant_id'), `${t} 缺 tenant_id`);
    }
  });

  it('★人格特征三表主键已复合（K2 落地后）★：decision_style/cognitive_model/narrative = (tenant_id, persona_id)', () => {
    /* 本测试跑全量迁移链(含 K2 v107)，故三张人格特征表主键已是复合。 */
    for (const t of SINGLETON_TABLES) {
      const pkCols = cols(t).filter((c) => c.pk > 0).map((c) => c.name).sort();
      assert.deepEqual(pkCols, ['persona_id', 'tenant_id'], `${t} 主键应为 (tenant_id, persona_id)`);
    }
  });

  it('★K2 executor ON CONFLICT(tenant_id, persona_id)★：同 (tenant,persona) upsert 唯一，多 persona 共存', () => {
    const ins = `INSERT INTO decision_style (tenant_id, persona_id, style_json, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(tenant_id, persona_id) DO UPDATE SET style_json = excluded.style_json, updated_at = excluded.updated_at`;
    db.prepare<void>(ins).run('t1', 'p1', '{"v":1}', 1000);
    db.prepare<void>(ins).run('t1', 'p1', '{"v":2}', 2000); /* 同 (t1,p1) → upsert */
    db.prepare<void>(ins).run('t1', 'p2', '{"v":9}', 1000); /* 不同 persona → 新行 */
    const rows = db.prepare<{ persona_id: string; style_json: string }>(`SELECT persona_id, style_json FROM decision_style WHERE tenant_id='t1' ORDER BY persona_id`).all();
    assert.equal(rows.length, 2, '两 persona 各一行');
    assert.match(rows[0]!.style_json, /"v":2/, 'p1 upsert 更新');
    assert.match(rows[1]!.style_json, /"v":9/, 'p2 独立');
  });

  it('★按 persona_id 列区分★：宽表 core_values 可按 persona_id 过滤出不同 persona 的数据', () => {
    db.prepare<void>(`INSERT INTO core_values (id, label, weight, updated_at, tenant_id, persona_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('v-a', '探索', 0.9, 1000, 't1', 'explorer-01');
    db.prepare<void>(`INSERT INTO core_values (id, label, weight, updated_at, tenant_id, persona_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('v-b', '稳健', 0.9, 1000, 't1', 'guardian-01');
    /* 同 tenant 两 persona 各一行(id 唯一);按 persona_id 过滤区分。 */
    const explorer = db.prepare<{ label: string }>(`SELECT label FROM core_values WHERE tenant_id=? AND persona_id=?`).all('t1', 'explorer-01');
    assert.equal(explorer.length, 1);
    assert.equal(explorer[0]!.label, '探索');
    const all = db.prepare<{ id: string }>(`SELECT id FROM core_values WHERE tenant_id=?`).all('t1');
    assert.equal(all.length, 2, '同 tenant 容纳两 persona 的值');
  });

  it('★向后兼容回填★：persona_id 默认 default（旧路径不传 persona 落 default 行）', () => {
    /* 模拟 K2 前的旧写法（不带 persona_id 列）——SQLite 默认值生效。 */
    db.prepare<void>(`INSERT INTO narrative (tenant_id, content, updated_at) VALUES (?, ?, ?)`)
      .run('t-legacy', '我是默认人格', 1000);
    const row = db.prepare<{ persona_id: string; content: string }>(
      `SELECT persona_id, content FROM narrative WHERE tenant_id = ?`,
    ).get('t-legacy');
    assert.equal(row!.persona_id, 'default', '旧写法默认 default persona');
    assert.equal(row!.content, '我是默认人格');
  });


  it('★复合索引存在★：idx_*_tenant_persona 供 K2 按 persona 查', () => {
    const idx = db.prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_tenant_persona'`).all();
    const names = idx.map((i) => i.name);
    for (const t of ['core_values', 'survival_anchors', 'memory_nodes', 'memory_edges']) {
      assert.ok(names.includes(`idx_${t}_tenant_persona`), `缺复合索引 idx_${t}_tenant_persona`);
    }
  });
});
