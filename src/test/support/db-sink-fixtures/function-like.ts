/**
 * A1 接收边界样本 —— FunctionExpression + setter 参数（Codex 第 6 轮）。
 *
 * 显式 pin 这两种 function-like，验 A1 用 `ts.isFunctionLike` 真覆盖（而非手列节点
 * 漏掉 FunctionExpression / SetAccessorDeclaration）：
 *  - fnExpr：`const fnExpr = function(db: IDatabase) {}`（FunctionExpression）
 *    → fn-param，owner=fnExpr，target=fnExpr，param=db。
 *  - DbHolder.database：`set database(db: IDatabase)`（SetAccessorDeclaration）
 *    → fn-param，owner=DbHolder.database，target=set database，param=db。
 *
 * 变异自证：把 A1 从 ts.isFunctionLike 换成手列（不含 FunctionExpression）→ fnExpr
 * 的 edge 消失，本文件 deepEqual 测试应变红。
 */
import type { IDatabase } from '../../../storage/database.js';

/** FunctionExpression 赋给 const：owner/target = 变量名 fnExpr。 */
export const fnExpr = function (db: IDatabase): void {
  void db;
};

/** class setter：owner=DbHolder.database，target='set database'。 */
export class DbHolder {
  set database(db: IDatabase) {
    void db;
  }
}
