/**
 * B8 转移边界样本 —— module/export transfer。
 *
 *  - `export default db`（ExportAssignment）→ module-export，target=default，param=db。
 *  - `export { db2 }`（ExportDeclaration / NamedExports / ExportSpecifier）→ module-export,
 *    target=named，param=db2。
 *
 * db / db2 声明为 ambient（declare const）——不产 acceptance / B1 decl-init edge，
 * 只在被 export 引用时经 module-export 边界识别。owner=<module>（module 顶层）。
 */
import type { IDatabase } from '../../../storage/database.js';

/** ambient：module 顶层的 DB 绑定（不产 acceptance edge）。 */
declare const db: IDatabase;
/** ambient：另一个 module 顶层 DB 绑定。 */
declare const db2: IDatabase;

// export default db —— ExportAssignment，转移 DB 能力出模块边界。
export default db;

// export { db2 } —— NamedExports，转移 DB 能力出模块边界。
export { db2 };
