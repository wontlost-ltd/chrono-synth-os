import { defineMigration, type Migration } from '../../index.js';

/**
 * 感知媒体引用（ADR-0052 Edge-P5 / ADR-0051 Phase 3）— perception_media_refs。
 *
 * 多模态感知的原始音视频是**最敏感 PII，绝不进主业务库**（红线）。本表只存媒体的**引用元数据**：
 * 对象存储 key、内容哈希、mime、大小、时长、保留策略、过期时刻、处理状态——原始媒体本体存对象
 * 存储（S3/R2/minio/BYOS），主库只持引用。retention worker 按 delete_after 清理过期引用并触发
 * 对象存储 erase；GDPR 擦除同时删 DB 行 + 调对象存储 erase hook。
 *
 * 字段决策：
 *   - id 主键；tenant_id 默认 'default'（多租户隔离 + GDPR）；
 *   - object_key 对象存储定位键（**能定位媒体，导出时脱敏不返回**）；sha256 内容哈希（去重/审计）；
 *   - mime/size_bytes/duration_ms 媒体元数据；
 *   - retention_class 保留级别（如 'process-and-delete' / 'short' / 'user-retained'）；
 *   - delete_after 过期时刻（epoch ms，nullable=永久保留前不设）；
 *   - status 处理状态（pending/processed/erased）；created_at epoch ms（ADR-0029）。
 *
 * 含 tenant_id → 进 TenantDatabase 自动隔离 + privacy 导出（**object_key 脱敏不导出**，B 类）/擦除。
 *
 * Alias：SQLite v086 / Postgres v088（紧跟 v085 tenant_llm_settings / Postgres v087）。
 */
export const v086_perception_media_refs: Migration = defineMigration({
  kind: 'schema',
  id: '086-perception-media-refs',
  aliases: { postgres: 'v088', 'sqlite-sql': 'v086' },
  description: 'ADR-0052 Edge-P5: perception media reference metadata (raw media stays in object storage)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'perception_media_refs',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          /* 对象存储定位键（原始媒体在对象存储，主库只存引用）。 */
          { name: 'object_key', type: 'text', nullable: false },
          { name: 'sha256', type: 'text', nullable: false },
          { name: 'mime', type: 'text', nullable: false },
          { name: 'size_bytes', type: 'bigint', nullable: false, default: 0 },
          { name: 'duration_ms', type: 'bigint', nullable: false, default: 0 },
          { name: 'retention_class', type: 'text', nullable: false, default: 'process-and-delete' },
          /* 过期时刻（retention worker 清理用）；NULL = 用户选择永久保留前不过期。 */
          { name: 'delete_after', type: 'bigint' },
          { name: 'status', type: 'text', nullable: false, default: 'pending' },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_perception_media_refs_tenant',
        table: 'perception_media_refs',
        columns: ['tenant_id'],
        ifNotExists: true,
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_perception_media_refs_expiry',
        table: 'perception_media_refs',
        columns: ['delete_after'],
        ifNotExists: true,
      },
    },
  ],
});
