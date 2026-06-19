import { defineMigration, type Migration } from '../../index.js';

/**
 * 记忆内容多语变体表（ADR-0055 内容多语）。
 *
 * 数字人格的记忆内容（memory_nodes.content）是教学时老师输出的单一语言。要让**内容本身**跨语言
 * （英文用户问中文教的概念→英文答），把记忆翻译成目标语言存为变体——一条记忆 = 一个语义单元，
 * 多个语言面。翻译由**成长期** LLM 老师完成（POST /companion/me/translate），运行时 chat 只读取
 * 已存变体（零-LLM）：按用户语言取对应变体匹配/呈现，无变体回退主 content。
 *
 * per (tenant_id, memory_id, language) 一行：
 *   - text：该记忆在 language 语言下的内容变体。
 *   - source：翻译来源（teacher=LLM 老师翻译；可扩展）。
 *
 * 含 tenant_id 且无敏感列 → TenantDatabase 自动隔离 + privacy A 类标准导出/擦除。
 * memory_id 外键级联删除：记忆被删时其翻译变体一并清除。
 *
 * Alias：SQLite v094 / Postgres v096（紧跟 v093 companion_identity / Postgres v095）。
 */
export const v094_memory_translations: Migration = defineMigration({
  kind: 'schema',
  id: '094-memory-translations',
  aliases: { postgres: 'v096', 'sqlite-sql': 'v094' },
  description: 'ADR-0055 content multilingual: per-language memory content variants',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'memory_translations',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'memory_id', type: 'text', nullable: false, references: { table: 'memory_nodes', column: 'id', onDelete: 'CASCADE' } },
          /* 语言标签（与 SUPPORTED_LOCALES 对齐，如 'en' / 'zh-CN'）。 */
          { name: 'language', type: 'text', nullable: false },
          /* 该记忆在 language 下的内容变体。 */
          { name: 'text', type: 'text', nullable: false },
          /* 翻译来源（teacher=LLM 老师）。 */
          { name: 'source', type: 'text', nullable: false, default: 'teacher' },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'memory_id', 'language'] },
        ],
      },
    },
    /* 按 (tenant, language) 拉某语言全部变体（呈现/检索预加载）。 */
    {
      kind: 'create-index',
      index: { name: 'idx_memory_translations_tenant_lang', table: 'memory_translations', columns: ['tenant_id', 'language'], ifNotExists: true },
    },
  ],
});
