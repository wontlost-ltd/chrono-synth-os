/**
 * capability-carrier 压缩 + resolved provenance —— **不安全**样本（Task 2.6，Codex 第 8 轮）。
 *
 * Codex 最强调的一条：carrier 压缩**绝不能**退化成「按类型名当安全 opaque 放行」。这些 facade
 * 可以被 `new ChronoSynthOS({ db: hostDb })` 直接构造、store 可以被 `new CognitiveMemoryGraph(hostDb)`
 * 单独拎出——此时 db 来源是**未解析的宿主 db（hostDb）**，不是按租户/人格解析出来的。按类型名放行
 * 会漏掉这类真·错-shard 隐患。
 *
 * 故 provenance 追来源：
 *  - 来源 = `new ChronoSynthOS(...)` / `deps.os` / 未知函数返回 → `unresolved-carrier`（**门红**）。
 *  - 内部 store 直接构造 `new CognitiveMemoryGraph(hostDb)`：hostDb 是直接 UoW（非 carrier），
 *    仍产直接 sink edge（不被 carrier 压缩吞掉）；且 CognitiveMemoryGraph 自身的 ctor 参数 tx
 *    仍是独立 semantic sink（内部 store 直接 sink 保留）。
 */
import { ChronoSynthOS } from '../../../chrono-synth-os.js';
import { CognitiveMemoryGraph } from '../../../core/memory-graph.js';
import type { IDatabase } from '../../../storage/database.js';
import type { Clock } from '../../../utils/clock.js';
import { useOs } from './carrier-safe.js';

/** ambient：一个未解析的宿主 db 句柄（直接 UoW；IDatabase extends SyncWriteUnitOfWork，
 *  可赋给 ChronoSynthOSConfig.db 与 CognitiveMemoryGraph 的 SyncWriteUnitOfWork ctor 参）。 */
declare function hostDb(): IDatabase;
/** ambient：clock（CognitiveMemoryGraph ctor 第二参，非 DB，不产 edge）。 */
declare const clock: Clock;

/**
 * 不安全来源：os 由 `new ChronoSynthOS({ db: hostDb() })` **直接构造**（未经 resolver）→
 * 传给 useOs 的实参 edge 应归 unresolved-carrier（provenance 跟到 NewExpression 而非 getTenantOS）。
 */
export function unsafeOsFromNew(): void {
  const os = new ChronoSynthOS({ db: hostDb() });
  useOs(os);
}

/**
 * 内部 store 直接构造：`new CognitiveMemoryGraph(hostDb())`——hostDb 是直接 UoW（path=[]），
 * 是直接 sink（factory-indirect target=CognitiveMemoryGraph），**不**被 carrier 压缩吞。
 * 且 db 来源是 hostDb（未解析）——这正是「直接拎出 store 传宿主 db」的错-shard 形态。
 */
export function unsafeStoreFromNew(): CognitiveMemoryGraph {
  return new CognitiveMemoryGraph(hostDb(), clock);
}
