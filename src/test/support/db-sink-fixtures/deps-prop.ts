/**
 * A4 接收边界样本 —— interface/type 的 db 属性（PropertySignature）持有 DB 能力。
 *
 * deps 契约里的 db 属性命中 A4（PropertySignature），edge kind = deps-prop。
 */
import type { IDatabase } from '../../../storage/database.js';

/** deps 契约的 db 属性直接持有 DB 能力：edge kind = deps-prop。 */
export interface FixtureDeps {
  db: IDatabase;
}
