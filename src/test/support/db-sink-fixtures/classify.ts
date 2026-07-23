/**
 * classifyPropagation 三态 fixture（Task 2.5）—— 机器归因每条传播 edge。
 *
 * classifyPropagation(edge, checker) → 'linked-to-sink' | 'ephemeral' | 'terminal-escape' | 'unknown'：
 *  - linked-to-sink：能机械定位终点=一个已扫描的 A 接收点（`new ClassifyService(db)` →
 *    ClassifyService.ctor(db)，A2 ctor-param）。归因带 sinkId 指向该 A 点 edge。
 *  - terminal-escape：能力逃逸出本作用域/生命周期（`export default escapingDb` → module-export，
 *    离开模块边界，无法映射到任何本 Program 内的 A 点）。
 *  - ephemeral：机械证明不逃逸（`ephemeralUse(db)` 里 db 只**同步**传给一个 per-request 的
 *    本地纯函数 useOnce，不 return / 不存字段 / 不注册 callback / 不写容器）。
 *
 * 注意：ClassifyService 是**真实** class（非 ambient），故它自身的 ctor 参数会产一条
 * A2 ctor-param edge（sink declaration）——那是 linked-to-sink 的「终点」。
 */
import type { IDatabase } from '../../../storage/database.js';

/** ambient host：提供 DB 句柄（无参 → 不产 acceptance edge）。 */
declare function hostDb(): IDatabase;

/** 真实 service：ctor 持有 db（A2 ctor-param）——linked-to-sink 的终点 A 点。 */
export class ClassifyService {
  constructor(private readonly db: IDatabase) {
    void this.db;
  }
}

/** linked-to-sink：new ClassifyService(db) 的实参 edge → 终点是 ClassifyService.ctor(db)。 */
export function makeService(): ClassifyService {
  return new ClassifyService(hostDb());
}

/** 一个 per-request 的本地纯函数：只同步用一次 db，不逃逸。 */
function useOnce(db: IDatabase): void {
  db.execute({ sql: 'SELECT 1', params: [] } as never);
}

/**
 * ephemeral：db 只同步传给本地纯函数 useOnce，不 return / 不存 / 不注册 / 不写容器。
 * ephemeralUse 自身的 db 参数是 A1 fn-param（sink declaration）；它把 db **同步**转给 useOnce
 * 的那条 factory-indirect edge 应归 ephemeral（useOnce 是明确的 per-request 本地函数）。
 */
export function ephemeralUse(db: IDatabase): void {
  useOnce(db);
}

/** ambient：一个 module 顶层 DB 绑定，被 export default 逃逸出模块边界。 */
declare const escapingDb: IDatabase;

/** terminal-escape：export default escapingDb → 能力离开模块边界（module-export）。 */
export default escapingDb;
