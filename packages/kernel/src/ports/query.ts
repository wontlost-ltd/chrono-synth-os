/**
 * 类型安全的查询与命令规范
 * 替代裸 SQL，提供跨运行时的数据访问抽象
 */

/** 只读查询规范 — TResult 标记返回类型，TParams 约束参数类型 */
export interface Query<TResult, TParams = unknown> {
  readonly kind: string;
  readonly params: TParams;
  /** 类型推导标记（运行时不使用） */
  readonly _result?: TResult;
}

/** 写入命令规范 */
export interface Command<TParams = unknown> {
  readonly kind: string;
  readonly params: TParams;
}

/** 命令执行结果 */
export interface ExecResult {
  readonly rowsAffected: number;
}
