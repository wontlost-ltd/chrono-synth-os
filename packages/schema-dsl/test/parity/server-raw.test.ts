import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DISABLED_MIGRATIONS, RAW_MIGRATIONS } from '../../src/migrations/server-raw/index.js';
import { PostgresRenderer, renderToPostgres } from '../../src/renderers/postgres.js';
import { renderToSqlite, SqliteSqlRenderer } from '../../src/renderers/sqlite-sql.js';
import type { RawMigration } from '../../src/types.js';

const BOTH_DIALECT_RAW = ['v007', 'v027', 'v030', 'v034', 'v040', 'v041', 'v047', 'v052'] as const;

describe('server-raw coverage', () => {
  it('covers PR3 raw migrations', () => {
    const rawVersions = RAW_MIGRATIONS
      .map(migration => migration.aliases.postgres ?? migration.aliases['sqlite-sql'])
      .sort();

    /* v090 = v088_distilled_artifacts_perception_source（pg-aliased v090，SQLite CHECK rebuild / PG alter
     * constraint，PR #119 加入但当时漏更新本覆盖列表——此处补齐，与 RAW_MIGRATIONS 实际一致）。 */
    /* v108 = v106_persona_id_core_isolation（pg-aliased v108，K1 ADR-0056 per-(tenant,persona) 核心隔离；
     * 纯加性：7 张核心表 ADD COLUMN persona_id(default default) + 复合索引，不改主键/唯一约束——
     * 主键改 + executor 改 ON CONFLICT(tenant_id,persona_id) 延后到 K2 原子落，K1 完全向后兼容）。 */
    /* v121 = v119_github_integration（pg-aliased v121，GitHub 集成地基：建 github_app_credentials +
     * github_installations 两表，纯建表 DDL 无 DML；两表含 tenant_id 纳入隔离/GDPR 清单）。 */
    /* v122 = v120_github_learn_state（pg-aliased v122，GitHub 学习段地基：建 github_learn_state 增量同步
     * 游标账本 + github_ingest_digests 摄入幂等账本，纯建表 DDL；两表含 tenant_id 纳入隔离/GDPR 清单。
     * Plan 2 加入 RAW_MIGRATIONS 时漏更新本覆盖列表——已补齐，与实际一致）。 */
    /* v123 = v121_github_reply_drafts（pg-aliased v123，GitHub 反馈起草段地基：建 github_reply_drafts 回复
     * 草稿账本 + github_webhook_events webhook 幂等账本（复合主键 (tenant_id, delivery_id)），纯建表 DDL；
     * 两表含 tenant_id 纳入隔离/GDPR 清单）。 */
    /* v124 = v122_github_draft_published（pg-aliased v124，GitHub 反馈发布段地基：github_reply_drafts status
     * CHECK 加 published 终态 + published_at/github_ref 审计列，PG 原地 ALTER / SQLite 重建表）。 */
    /* v126 = v124_tenant_bootstrap_backfill（pg-aliased v126，租户分片 Phase 0 Plan 1c：tenant_bootstrap
     * 完成标记表 + 历史身份回填至 tenant_identity_directory，含 email 归一化与 fail-closed 重复检测；
     * 数据迁移故用 raw。该迁移加入 RAW_MIGRATIONS 时漏更新本覆盖列表——此处补齐，与实际一致）。 */
    /* v127 = v125_github_digest_discussion_key（pg-aliased v127，GitHub 讨论内容摄入：github_ingest_digests
     * 加 discussion_key（讨论稳定标识）+ memory_id（该讨论当前记忆指针）+ 二级索引，支撑演进式取代——
     * contentSha 含评论后随讨论变化致去重账本失效，故以稳定讨论键定位并取代上一版记忆；纯加列不重建表）。 */
    /* v128 = v126_github_learn_state_org_rotation（pg-aliased v128，GitHub 组织级驻留：
     * github_learn_state.resource_type CHECK 扩加 _org_rotation 哨兵，供组织轮转游标复用该表
     * 存「下一个起始下标」；新 CHECK 是旧取值超集，既有行全合法；SQLite 重建表（RENAME 后先
     * DROP INDEX 防静默丢唯一索引），PG 原地 ALTER CONSTRAINT）。 */
    /* v129 = v127_github_installation_suspended（pg-aliased v129，GitHub 安装入口产品化：
     * github_installations 加 suspended_at 暂停状态列，由 installation.suspend/unsuspend
     * webhook 事件维护；纯加列不重建表，既有唯一索引原地保留）。 */
    assert.deepEqual(rawVersions, ['v007', 'v027', 'v030', 'v034', 'v040', 'v041', 'v047', 'v052', 'v071', 'v090', 'v108', 'v109', 'v121', 'v122', 'v123', 'v124', 'v126', 'v127', 'v128', 'v129']);
  });

  it('covers disabled raw migrations', () => {
    assert.deepEqual(DISABLED_MIGRATIONS.map(migration => migration.aliases.postgres), ['v072']);
    assert.equal(DISABLED_MIGRATIONS[0]?.disabled, true);
  });
});

describe('server-raw renderer behavior', () => {
  for (const version of BOTH_DIALECT_RAW) {
    it(`${version} renders postgres SQL`, () => {
      const migration = findRawByPostgresVersion(version);
      assert.ok(renderToPostgres(migration).length > 0);
    });

    it(`${version} renders sqlite SQL`, () => {
      const migration = findRawBySqliteVersion(version);
      assert.ok(renderToSqlite(migration).length > 0);
    });
  }

  it('v071_pg renders postgres SQL', () => {
    const migration = findRawByPostgresVersion('v071');
    assert.ok(renderToPostgres(migration).length > 0);
  });

  it('v071_pg is a sqlite no-op', () => {
    const migration = findRawByPostgresVersion('v071');
    assert.deepEqual(renderToSqlite(migration), []);
    assert.equal(new SqliteSqlRenderer().renderMigration(migration), null);
  });

  it('v106 (K1 persona_id core isolation) renders both dialects', () => {
    /* pg alias v108 / sqlite alias v106 不同（与 v071_pg 同款单独测，不混进 BOTH_DIALECT_RAW 的同名假设）。 */
    const byPg = findRawByPostgresVersion('v108');
    const bySqlite = findRawBySqliteVersion('v106');
    assert.equal(byPg, bySqlite, 'same migration via either alias');
    assert.ok(renderToPostgres(byPg).length > 0, 'PG SQL non-empty');
    assert.ok(renderToSqlite(bySqlite).length > 0, 'SQLite SQL non-empty');
  });

  it('v072_pg disabled is omitted by default', () => {
    const migration = DISABLED_MIGRATIONS[0];
    assert.ok(migration);
    assert.deepEqual(renderToPostgres(migration), []);
    assert.equal(new PostgresRenderer().renderMigration(migration), null);
  });

  it('v072_pg disabled can render when explicitly included', () => {
    const migration = DISABLED_MIGRATIONS[0];
    assert.ok(migration);
    assert.ok(renderToPostgres(migration, { includeDisabled: true }).length > 0);
    const rendered = new PostgresRenderer().renderMigration(migration, {
      target: 'postgres',
      includeDisabled: true,
    });
    assert.equal(rendered?.disabled, true);
  });
});

function findRawByPostgresVersion(version: string): RawMigration {
  const migration = RAW_MIGRATIONS.find(item => item.aliases.postgres === version);
  assert.ok(migration, `missing raw postgres migration ${version}`);
  return migration;
}

function findRawBySqliteVersion(version: string): RawMigration {
  const migration = RAW_MIGRATIONS.find(item => item.aliases['sqlite-sql'] === version);
  assert.ok(migration, `missing raw sqlite migration ${version}`);
  return migration;
}
