/**
 * B7 转移边界样本 —— 闭包 / timer capture（引用作用域外的 DB 绑定）。
 *
 * `makeTimer(db)` 的 db 是 makeTimer 的参数（本应 A1 route-param），但它被内层
 * setTimeout 回调（一个 ArrowFunction 闭包）**捕获**——这是 B7 capture。
 *
 * specificity precedence（capture 覆盖 acceptance）：一个绑定既是函数参数（acceptance）
 * 又被嵌套闭包捕获时，只报**更危险的** capture edge（长期持有的引用），压制 acceptance——
 * 故本文件恰产一条 capture edge：owner=makeTimer / kind=capture / target=makeTimer / param=db。
 *
 * 对照 route-param.ts：那里的 db 参数**没有**被任何嵌套闭包引用 → 仍报 route-param。
 */
import type { IDatabase } from '../../../storage/database.js';

/**
 * db 是 makeTimer 的参数，被内层 setTimeout 闭包捕获 → B7 capture。
 * 因被捕获，acceptance（route-param）被压制，只产 capture edge。
 */
export function makeTimer(db: IDatabase): void {
  setTimeout(() => {
    db.execute({ sql: 'DELETE FROM fixture_t', params: [] } as never);
  }, 1000);
}
