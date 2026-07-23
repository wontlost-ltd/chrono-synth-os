/**
 * 包裹型能力转移样本 —— 整体表达式类型**不可**直接赋 UoW，靠 findDbCapabilityPaths
 * 递归识别其内部携带的 DB 能力路径（Codex 第 3 轮 #2）。
 *
 *  - wrapOptions：`new Service(options)`，options 类型 { db: IDatabase }（整体不可赋 UoW，
 *    但路径 options.db 是 UoW）→ B2 factory-indirect，target=Service，param=options.db。
 *  - wrapReturn：`return { db }` → B5 return，param=db。
 *  - wrapSpread：`{ ...deps }`（deps 含 db）→ B4 aggregate-wrapping，target=object，param=...deps。
 */
import type { IDatabase } from '../../../storage/database.js';

/** ambient：提供 DB 句柄。 */
declare function hostDb(): IDatabase;
/** ambient：构造函数参数是包裹对象 { db }，整体不可赋 UoW，路径 options.db 可赋。 */
declare class Service {
  constructor(options: { db: IDatabase });
}
/** ambient：一个含 db 的 deps 值，供 spread（ambient → 不产 acceptance edge）。 */
declare const deps: { db: IDatabase };

/** new Service(options)：options.db 是 UoW（包裹）→ factory-indirect target=Service param=options.db。 */
export function wrapOptions(): Service {
  return new Service({ db: hostDb() });
}

/** return { db }：返回对象携带 db → B5 return，param=db。 */
export function wrapReturn(): { db: IDatabase } {
  return { db: hostDb() };
}

/**
 * { ...deps }：spread 携带 db → B4 aggregate-wrapping，target=object，param=...deps。
 * 对象字面量作为独立表达式语句（不在 return/call/new/初始化位置），
 * 故按角色阶梯落到 aggregate-wrapping，恰产一条 edge。
 */
export function wrapSpread(): void {
  void { ...deps };
}
