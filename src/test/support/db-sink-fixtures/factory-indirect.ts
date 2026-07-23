/**
 * B2 转移边界样本 —— new/call 实参把 DB 能力交给不同 target。
 *
 * 关键验收锚（edge 级不合并）：同一 owner（FactoryFixture）内 `new ServiceA(...)`
 * 与 `new ServiceB(...)` 是**两条不同 edge**（不同 target），证明按 edge 级枚举、
 * 禁按 owner 合并。
 *
 * ServiceA/ServiceB 声明为 `declare class`（ambient）——其构造函数参数是外部契约桩，
 * 不属于本文件拥有的 sink declaration，故 acceptance 扫描跳过 ambient，不产额外 edge。
 * hostDb() 是 ambient function（无 DB 参数），只提供 DB 值，本身不产 edge。
 */
import type { IDatabase } from '../../../storage/database.js';

/** ambient：提供 DB 句柄的 host 函数（无参数 → 不产 acceptance edge）。 */
declare function hostDb(): IDatabase;
/** ambient：外部 service 桩（构造函数参 db 携带 DB 能力，但 ambient → 不产 acceptance edge）。 */
declare class ServiceA {
  constructor(db: IDatabase);
}
declare class ServiceB {
  constructor(db: IDatabase);
}

/** 同 owner 内两个不同 target 的 new：产 2 条 factory-indirect edge（不合并）。 */
export function FactoryFixture(): void {
  void new ServiceA(hostDb());
  void new ServiceB(hostDb());
}
