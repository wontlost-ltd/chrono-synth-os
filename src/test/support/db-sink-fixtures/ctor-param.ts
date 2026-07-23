/**
 * A1/A2 接收边界样本 —— 构造函数参数属性（parameter property）持有 DB 能力。
 *
 * `constructor(private readonly db: IDatabase)` 命中 A2（parameter property），
 * 按 specificity precedence 只归 A2（不再另产 A1 fn-param）。
 */
import type { IDatabase } from '../../../storage/database.js';

/** 构造函数参数属性直接持有 DB 能力：edge kind = ctor-param。 */
export class CtorParamFixture {
  constructor(private readonly db: IDatabase) {
    void this.db;
  }
}
