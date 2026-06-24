import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VERSION_MAP } from '../src/version-map.js';

describe('VERSION_MAP', () => {
  it('covers every postgres migration version', () => {
    assert.deepEqual(
      versionsFor('postgres'),
      range('v', 1, 114),
    );
  });

  it('covers every sqlite SQL migration version', () => {
    assert.deepEqual(
      versionsFor('sqlite-sql'),
      range('v', 1, 112),
    );
  });

  it('has unique canonical names', () => {
    const names = VERSION_MAP.map(entry => entry.canonical);
    assert.equal(new Set(names).size, names.length);
  });

  it('does not assign sqlite SQL aliases to pg-only entries', () => {
    for (const entry of VERSION_MAP.filter(item => item.classification === 'pg-only')) {
      assert.equal(entry.aliases['sqlite-sql'], undefined, entry.canonical);
    }
  });

  it('classifies disabled entries explicitly', () => {
    const disabled = VERSION_MAP.filter(entry => entry.canonical === 'v072_pg' || entry.aliases.postgres === 'v072');
    assert.deepEqual(disabled.map(entry => entry.classification), ['disabled']);
  });

  /*
   * 跨 renderer 结构一致性（P2-x）：schema-simple/schema-raw 是「两端都该有」的迁移，必须同时
   * 拥有 postgres 与 sqlite-sql 别名——否则一端漏掉会造成 PG/SQLite schema 静默漂移（本仓反复
   * 踩过的坑）。pg-only 只该有 postgres；disabled 不参与渲染。本测试把这些约束钉死，防漂移。
   */
  it('schema-simple/schema-raw 条目两端别名齐全（防 PG/SQLite 漂移）', () => {
    const drifted: string[] = [];
    for (const entry of VERSION_MAP) {
      if (entry.classification === 'schema-simple' || entry.classification === 'schema-raw') {
        if (!entry.aliases.postgres) drifted.push(`${entry.canonical}: 缺 postgres 别名`);
        if (!entry.aliases['sqlite-sql']) drifted.push(`${entry.canonical}: 缺 sqlite-sql 别名`);
      }
    }
    assert.deepEqual(drifted, [], `跨 renderer 漂移:\n${drifted.join('\n')}`);
  });

  it('pg-only 条目有 postgres 别名、无 sqlite-sql 别名', () => {
    for (const entry of VERSION_MAP.filter(e => e.classification === 'pg-only')) {
      assert.ok(entry.aliases.postgres, `${entry.canonical}: pg-only 须有 postgres 别名`);
      assert.equal(entry.aliases['sqlite-sql'], undefined, `${entry.canonical}: pg-only 不该有 sqlite-sql 别名`);
    }
  });

  it('每个条目至少有一个非空别名（无悬空条目）', () => {
    for (const entry of VERSION_MAP) {
      const hasAny = Object.values(entry.aliases).some(v => Boolean(v));
      assert.ok(hasAny, `${entry.canonical}: 条目无任何别名（悬空）`);
    }
  });
});

function versionsFor(target: 'postgres' | 'sqlite-sql'): readonly string[] {
  return VERSION_MAP
    .map(entry => entry.aliases[target])
    .filter((version): version is string => Boolean(version))
    .sort();
}

function range(prefix: string, start: number, end: number): readonly string[] {
  return Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${String(start + index).padStart(3, '0')}`);
}
