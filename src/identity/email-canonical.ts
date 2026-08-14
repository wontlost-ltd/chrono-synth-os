/**
 * 登录标识归一化的单一真源。
 *
 * v124 迁移把存储侧的 `users.email` 归一化为 `LOWER(TRIM(email))`，登录/注册的查询与写入输入侧
 * 必须与之对齐：否则老用户以 `User@Example.com` 注册后，v124 跑完存储变 `user@example.com`，
 * 再用原大小写登录会精确匹配落空 → 账号锁死（违反「绝不破坏用户空间」铁律）。
 *
 * 归一化 = 去首尾空白 + 转小写，与迁移的 `LOWER(TRIM(email))` 语义一一对应。此函数是纯函数，
 * 也是分片 Plan 1c 后续 Task（login 走 tenant_identity_directory 目录）复用的输入归一化层：
 * 届时查找入口变了，但输入先经此归一化这层不变。
 */
export function canonicalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
