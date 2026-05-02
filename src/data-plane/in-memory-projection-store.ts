import type { ProjectionStore, ProjectionFilter, ProjectionPage } from '@chrono/data-plane';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface Entry {
  value: unknown;
  version: number;
}

export class InMemoryProjectionStore implements ProjectionStore {
  private readonly store = new Map<string, Map<string, Map<string, Entry>>>();

  private tenant(tenantId: string): Map<string, Map<string, Entry>> {
    let t = this.store.get(tenantId);
    if (!t) { t = new Map(); this.store.set(tenantId, t); }
    return t;
  }

  private proj(tenantId: string, projection: string): Map<string, Entry> {
    const t = this.tenant(tenantId);
    let p = t.get(projection);
    if (!p) { p = new Map(); t.set(projection, p); }
    return p;
  }

  async read<T>(tenantId: string, projection: string, id: string): Promise<T | null> {
    return (this.proj(tenantId, projection).get(id)?.value ?? null) as T | null;
  }

  async write<T>(
    tenantId: string,
    projection: string,
    id: string,
    value: T,
    version: number,
  ): Promise<void> {
    this.proj(tenantId, projection).set(id, { value, version });
  }

  async list<T>(
    tenantId: string,
    projection: string,
    filter?: ProjectionFilter,
  ): Promise<ProjectionPage<T>> {
    const p = this.proj(tenantId, projection);
    const direction = filter?.direction ?? 'asc';
    const limit = Math.min(filter?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const cursor = filter?.cursor;

    let entries = [...p.entries()].sort(([a], [b]) =>
      direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a),
    );

    if (cursor !== undefined) {
      entries = entries.filter(([id]) =>
        direction === 'asc' ? id > cursor : id < cursor,
      );
    }

    const page = entries.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const items = page.slice(0, limit).map(([, entry]) => entry.value as T);
    const nextCursor = hasMore ? (page[limit - 1]![0]) : null;

    return { items, nextCursor };
  }

  clear(): void {
    this.store.clear();
  }
}
