/**
 * convertPlaceholders 单元测试
 * 验证 SQL 占位符 ? → $N 转换的各种边界情况
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertPlaceholders } from '../../storage/postgres-database.js';

describe('convertPlaceholders', () => {
  it('基本替换', () => {
    assert.equal(convertPlaceholders('SELECT ? WHERE id = ?'), 'SELECT $1 WHERE id = $2');
  });

  it('无占位符', () => {
    assert.equal(convertPlaceholders('SELECT 1'), 'SELECT 1');
  });

  it('单引号字符串内的 ? 不替换', () => {
    assert.equal(
      convertPlaceholders("INSERT INTO t (v) VALUES ('?')"),
      "INSERT INTO t (v) VALUES ('?')",
    );
  });

  it("标准 SQL '' 转义处理正确", () => {
    assert.equal(
      convertPlaceholders("SELECT 'it''s ?' WHERE x = ?"),
      "SELECT 'it''s ?' WHERE x = $1",
    );
  });

  it('双引号标识符内的 ? 不替换', () => {
    assert.equal(
      convertPlaceholders('SELECT "col?" FROM t WHERE id = ?'),
      'SELECT "col?" FROM t WHERE id = $1',
    );
  });

  it('行注释内的 ? 不替换', () => {
    assert.equal(
      convertPlaceholders('SELECT ? -- comment ?\nWHERE x = ?'),
      'SELECT $1 -- comment ?\nWHERE x = $2',
    );
  });

  it('块注释内的 ? 不替换', () => {
    assert.equal(
      convertPlaceholders('SELECT ? /* comment ? */ WHERE x = ?'),
      'SELECT $1 /* comment ? */ WHERE x = $2',
    );
  });

  it('美元引号内的 ? 不替换', () => {
    assert.equal(
      convertPlaceholders('SELECT $$hello ? world$$ WHERE id = ?'),
      'SELECT $$hello ? world$$ WHERE id = $1',
    );
  });

  it('带标签的美元引号内的 ? 不替换', () => {
    assert.equal(
      convertPlaceholders('SELECT $tag$hello ? world$tag$ WHERE id = ?'),
      'SELECT $tag$hello ? world$tag$ WHERE id = $1',
    );
  });

  it('JSONB 运算符 ?| 保留', () => {
    assert.equal(
      convertPlaceholders("SELECT data ?| array['a'] WHERE id = ?"),
      "SELECT data ?| array['a'] WHERE id = $1",
    );
  });

  it('JSONB 运算符 ?& 保留', () => {
    assert.equal(
      convertPlaceholders("SELECT data ?& array['a'] WHERE id = ?"),
      "SELECT data ?& array['a'] WHERE id = $1",
    );
  });

  it("E'...' 转义字符串内的 ? 不替换", () => {
    assert.equal(
      convertPlaceholders("SELECT E'it\\'s ?' WHERE x = ?"),
      "SELECT E'it\\'s ?' WHERE x = $1",
    );
  });

  it("E'...' 中反斜杠转义单引号", () => {
    assert.equal(
      convertPlaceholders("SELECT E'hello\\' ?' WHERE id = ?"),
      "SELECT E'hello\\' ?' WHERE id = $1",
    );
  });

  it("标识符末尾 e 后的引号按普通字符串处理", () => {
    /* 例如 WHERE'text' — e 是 WHERE 的一部分，不是 E'' 前缀 */
    assert.equal(
      convertPlaceholders("WHERE'?'"),
      "WHERE'?'",
    );
  });

  it('混合场景', () => {
    const sql = `INSERT INTO t (a, b, c) VALUES (?, ?, ?) -- comment ?
      ON CONFLICT(a) DO UPDATE SET b = ?, c = 'literal ?'`;
    const expected = `INSERT INTO t (a, b, c) VALUES ($1, $2, $3) -- comment ?
      ON CONFLICT(a) DO UPDATE SET b = $4, c = 'literal ?'`;
    assert.equal(convertPlaceholders(sql), expected);
  });
});
