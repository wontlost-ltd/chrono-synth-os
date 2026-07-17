/**
 * 确定性模哈希路由（分片地基 Phase 0）。
 *
 * `fnv1a64` 镜像 #311（decision-style-perturbation.ts 的私有 hashSeed）——同 offset/prime/掩码,
 * 同 charCodeAt（UTF-16 码元）语义,**非** UTF-8 byte 标准 FNV-1a。返回原始 64 位 BigInt（不 /2^64）。
 * 抽为公用纯函数,不 reach 内核私有实现。golden vector 锁定输出防漂移。
 *
 * `shardIdForTenant` = fnv1a64(tenantId) % N。这是**确定性模哈希**,非一致性哈希——
 * 增/删 shard 会重映射大部分 tenant（`% N` 无 minimal-disruption）。本片 shard 集合静态,故够用;
 * 动态增删=Phase 3 迁移编排。shardIds 内部排序后取模,config key 顺序变不重路由。
 */

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xFFFFFFFFFFFFFFFFn;

/** FNV-1a 64 位（charCodeAt UTF-16 语义,同 #311）。同串恒同值。 */
export function fnv1a64(s: string): bigint {
  let h = FNV64_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV64_PRIME) & FNV64_MASK;
  }
  return h;
}

/** tenantId → shardId（确定性模哈希 % N;shardIds 内部排序保稳定）。空 shardIds 抛错。 */
export function shardIdForTenant(tenantId: string, shardIds: readonly string[]): string {
  if (shardIds.length === 0) throw new Error('shardIdForTenant: shardIds 不能为空');
  const sorted = [...shardIds].sort();
  const idx = Number(fnv1a64(tenantId) % BigInt(sorted.length));
  return sorted[idx]!;
}
