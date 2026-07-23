/**
 * A4 接收边界 + active-stack visited 验收锚（Codex 第 4 轮 #4）。
 *
 * `interface Pair { primary: IDatabase; replica: IDatabase }` 有**两个**都携带 DB 能力的
 * 属性。findDbCapabilityPaths 对 Pair 整体递归时，两条 path（primary / replica）都必须产出。
 *
 * 关键：visited 必须是**当前递归栈的 active-set**（进入某 type 时加入、退出该分支时移除），
 * 而非**全局** visited。全局 visited 会在探完 primary→IDatabase 后把 IDatabase 永久标记，
 * 导致 replica→IDatabase 被跳过 → 只剩 1 条 path（漏第二条）。变异自证：把 visited 改成
 * 全局 Set，本文件的 deepEqual 测试应变红（只剩 primary）。
 */
import type { IDatabase } from '../../../storage/database.js';

/** 双 DB 能力属性：产 2 条 deps-prop edge（primary / replica）。 */
export interface Pair {
  primary: IDatabase;
  replica: IDatabase;
}
