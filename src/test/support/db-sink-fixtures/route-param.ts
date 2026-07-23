/**
 * A1 接收边界样本 —— 普通函数（FunctionDeclaration）参数持有 DB 能力。
 *
 * `registerFixtureRoutes(app, db: IDatabase)` 的 db 参数命中 A1（function-like 参数），
 * 由 ts.isFunctionLike 覆盖 FunctionDeclaration，edge kind = route-param。
 */
import type { IDatabase } from '../../../storage/database.js';

/** 一个纯占位的 app 类型，与 DB 无关（negative control：不该产 edge）。 */
interface FixtureApp {
  register(path: string): void;
}

/** 路由注册函数的 db 参数持有 DB 能力：edge kind = route-param。 */
export function registerFixtureRoutes(app: FixtureApp, db: IDatabase): void {
  void app;
  void db;
}
