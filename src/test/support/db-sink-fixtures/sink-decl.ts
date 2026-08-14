/**
 * A2 / A3 接收边界样本 —— 无 initializer 的 sink declaration（Codex 第 4 轮 #2）。
 *
 *  - SinkService：`constructor(private readonly db: IDatabase)`（parameter property，A2）
 *    → ctor-param。按 specificity precedence 只归 A2（不再另产 A1 fn-param）。
 *  - SinkStore：`private db: IDatabase`（PropertyDeclaration，**无 initializer**，A3）
 *    → field-decl。无 initializer 也算 sink（最典型的「持有 DB 能力的字段」）。
 */
import type { IDatabase } from '../../../storage/database.js';

/** parameter property（无 initializer）：ctor-param。 */
export class SinkService {
  constructor(private readonly db: IDatabase) {
    void this.db;
  }
}

/** 无 initializer 的 class 字段：field-decl（有无 initializer 都算 sink）。 */
export class SinkStore {
  private db!: IDatabase;

  use(): void {
    void this.db;
  }
}
