/**
 * Projection Store — 读模型持久化抽象
 * 支持按投影名 + ID 读写，以及带分页的列表查询
 */

/** 排序方向 */
export type SortDirection = 'asc' | 'desc';

/** 投影过滤条件 — 排序基于投影 ID 的字典序，确保跨运行时可移植 */
export interface ProjectionFilter {
  readonly cursor?: string;
  readonly limit?: number;
  readonly direction?: SortDirection;
}

/** 分页结果信封 */
export interface ProjectionPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** 投影存储接口 — 所有运行时实现此接口 */
export interface ProjectionStore {
  read<T>(tenantId: string, projection: string, id: string): Promise<T | null>;
  write<T>(tenantId: string, projection: string, id: string, value: T, version: number): Promise<void>;
  list<T>(tenantId: string, projection: string, filter?: ProjectionFilter): Promise<ProjectionPage<T>>;
}
