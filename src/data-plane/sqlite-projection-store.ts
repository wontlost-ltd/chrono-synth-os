import type { IDatabase } from '../storage/database.js';
import type { ProjectionStore, ProjectionFilter, ProjectionPage } from '@chrono/data-plane';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface ProjectionRow {
  value_json: string;
}

export class SqliteProjectionStore implements ProjectionStore {
  constructor(private readonly db: IDatabase) {}

  async read<T>(tenantId: string, projection: string, id: string): Promise<T | null> {
    const row = this.db
      .prepare<ProjectionRow>(
        'SELECT value_json FROM projection_store WHERE tenant_id = ? AND projection = ? AND id = ?',
      )
      .get(tenantId, projection, id);
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  async write<T>(
    tenantId: string,
    projection: string,
    id: string,
    value: T,
    version: number,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO projection_store(tenant_id, projection, id, value_json, version, updated_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, projection, id) DO UPDATE
           SET value_json = excluded.value_json, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(tenantId, projection, id, JSON.stringify(value), version, Date.now());
  }

  async list<T>(
    tenantId: string,
    projection: string,
    filter?: ProjectionFilter,
  ): Promise<ProjectionPage<T>> {
    const direction = filter?.direction ?? 'asc';
    const limit = Math.min(filter?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const cursor = filter?.cursor;

    let rows: Array<{ id: string; value_json: string }>;

    if (cursor !== undefined) {
      const op = direction === 'asc' ? '>' : '<';
      rows = this.db
        .prepare<{ id: string; value_json: string }>(
          `SELECT id, value_json FROM projection_store
           WHERE tenant_id = ? AND projection = ? AND id ${op} ?
           ORDER BY id ${direction === 'asc' ? 'ASC' : 'DESC'}
           LIMIT ?`,
        )
        .all(tenantId, projection, cursor, limit + 1);
    } else {
      rows = this.db
        .prepare<{ id: string; value_json: string }>(
          `SELECT id, value_json FROM projection_store
           WHERE tenant_id = ? AND projection = ?
           ORDER BY id ${direction === 'asc' ? 'ASC' : 'DESC'}
           LIMIT ?`,
        )
        .all(tenantId, projection, limit + 1);
    }

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(r => JSON.parse(r.value_json) as T);
    const nextCursor = hasMore ? pageRows[pageRows.length - 1]!.id : null;

    return { items, nextCursor };
  }
}
