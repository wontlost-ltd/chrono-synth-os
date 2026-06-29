/**
 * Logical table store backing the web adapter.
 *
 * Each table is a Map<string, Row>. The adapter snapshots this whole structure
 * to the WebKVStore on every successful transaction commit; failed
 * transactions roll back to the pre-transaction snapshot in-memory.
 */

export type Row = Record<string, unknown>;

export interface TableSchema {
  /** Column that uniquely identifies each row. Defaults to "id". */
  readonly primaryKey: string;
}

export const DEFAULT_TABLE_SCHEMA: TableSchema = { primaryKey: 'id' };

export interface SerializedTable {
  readonly primaryKey: string;
  readonly rows: readonly Row[];
}

export interface SerializedSnapshot {
  readonly tables: Record<string, SerializedTable>;
}

export class InMemoryTables {
  private readonly tables = new Map<string, Map<string, Row>>();
  private readonly schemas = new Map<string, TableSchema>();

  defineTable(name: string, schema: TableSchema = DEFAULT_TABLE_SCHEMA): void {
    if (!this.tables.has(name)) {
      this.tables.set(name, new Map());
      this.schemas.set(name, schema);
    }
  }

  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  schemaOf(name: string): TableSchema {
    return this.schemas.get(name) ?? DEFAULT_TABLE_SCHEMA;
  }

  rows(name: string): readonly Row[] {
    const t = this.tables.get(name);
    if (!t) return [];
    return [...t.values()];
  }

  upsert(name: string, row: Row): void {
    const schema = this.schemaOf(name);
    const t = this.requireTable(name);
    /*
     * 校验**原始**主键值是否存在，而非 String(...) 后的结果——String(undefined)==='undefined'
     * 是非空字符串会绕过 !key 检查，使缺主键的行被静默存到 'undefined' 键下互相覆盖。
     * 显式拒绝 null/undefined；数字 0 / false 等合法主键值保留。
     */
    const rawKey = row[schema.primaryKey];
    if (rawKey === null || rawKey === undefined) {
      throw new Error(`row missing primary key ${schema.primaryKey} for table ${name}`);
    }
    t.set(String(rawKey), structuredClone(row));
  }

  delete(name: string, key: string): boolean {
    const t = this.tables.get(name);
    return t ? t.delete(key) : false;
  }

  find(name: string, predicate: (row: Row) => boolean): Row | undefined {
    const t = this.tables.get(name);
    if (!t) return undefined;
    for (const r of t.values()) {
      if (predicate(r)) return structuredClone(r);
    }
    return undefined;
  }

  filter(name: string, predicate: (row: Row) => boolean): Row[] {
    const t = this.tables.get(name);
    if (!t) return [];
    const out: Row[] = [];
    for (const r of t.values()) {
      if (predicate(r)) out.push(structuredClone(r));
    }
    return out;
  }

  serialize(): SerializedSnapshot {
    const out: Record<string, SerializedTable> = {};
    for (const [name, table] of this.tables) {
      out[name] = {
        primaryKey: this.schemaOf(name).primaryKey,
        rows: [...table.values()].map((r) => structuredClone(r)),
      };
    }
    return { tables: out };
  }

  hydrate(snapshot: SerializedSnapshot): void {
    this.tables.clear();
    this.schemas.clear();
    for (const [name, t] of Object.entries(snapshot.tables)) {
      this.defineTable(name, { primaryKey: t.primaryKey });
      const map = this.tables.get(name)!;
      for (const row of t.rows) {
        /*
         * 读取路径须与 upsert 写入校验对称（P2-r）：旧快照可能含缺主键的污染行
         * （fix 前 String(undefined)==='undefined' 漏网）。校验**原始**主键值——
         * 写入侧严格抛错拒绝，恢复侧容错**跳过**非法行（best-effort，避免单个污染行
         * 炸掉整个 hydrate/回滚），不把脏数据以 'undefined' 键复活。
         */
        const rawKey = row[t.primaryKey];
        if (rawKey === null || rawKey === undefined) continue;
        map.set(String(rawKey), structuredClone(row));
      }
    }
  }

  /** Snapshot the entire state. Used to roll back on transaction failure. */
  cloneState(): InMemoryTables {
    const next = new InMemoryTables();
    next.hydrate(this.serialize());
    return next;
  }

  /** Adopt all rows + schemas from another instance (used after rollback). */
  replaceWith(other: InMemoryTables): void {
    this.hydrate(other.serialize());
  }

  private requireTable(name: string): Map<string, Row> {
    const t = this.tables.get(name);
    if (!t) throw new Error(`unknown table: ${name}`);
    return t;
  }
}
