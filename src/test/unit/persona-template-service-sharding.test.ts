/**
 * PersonaTemplateService 多-shard 分片探针（#3 PersonaCoreService 双入口化子片
 * ——persona 块第二片，PersonaTemplateService Task 2 验收）。
 *
 * 覆盖 spec（docs/superpowers/specs/2026-07-18-persona-template-service-resolver-design.md）
 * 验收段 8 类探针，核心是 2/3/5（syncBuiltins 每 shard 一份 + instantiate 级联同 shard +
 * 升级半成功重跑收敛）：
 *   1. CRUD per-tenant 分流对称
 *   2. syncBuiltins 每 shard 一份（核心）
 *   3. instantiate 级联同 shard（核心，证 template/core resolver 一致）
 *   4. syncBuiltins 任一 shard 失败则抛（坏 shard 居中）
 *   5. syncBuiltins 升级半成功 → 重跑收敛（核心）
 *   6. UoW 模式
 *   7. 单库零回归
 *   8. update/delete TOCTOU 既有语义回归（get+execute 同 db）
 *
 * 用 FakeMultiShardResolver 注多个独立物理内存 db——单库下 dbForTenant 恒返同一 db，
 * 「每 shard 一份内置模板」「template/core 落同一 shard」这两条本片安全命脉测不出来；
 * 多 shard 布置是唯一能让「fan-out 漏 shard」「template/core 裂脑落不同 shard」产生
 * 可观测差异的手段。
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { PersonaTemplateService } from '../../enterprise/persona-template-service.js';
import { BUILTIN_TEMPLATE_SEEDS, BUILTIN_TENANT_ID } from '../../enterprise/persona-template-catalog.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver, type TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { throwingDb } from '../support/throwing-db.js';
import type { IDatabase } from '../../storage/database.js';

/** 建带全量 schema 的内存 SQLite db（迁移入口），一个 db = 一个 shard。 */
function tplDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 在给定 db 上插入一个 owner 用户，供 instantiate 的 createPersona FK/所有权校验用。 */
function seedOwner(db: IDatabase, tenantId: string, ownerUserId: string): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ownerUserId, `${ownerUserId}@example.com`, 'hash', 'member', tenantId, now, now);
}


/** 关键 helper：template 和 core 必须同 resolver，才能保证 instantiate 级联落同一 shard。 */
function stack(resolver: TenantDbResolver): PersonaTemplateService {
  const core = PersonaCoreService.fromResolver(resolver);
  return PersonaTemplateService.fromResolver(resolver, core);
}

/** 统计给定 db 上 persona_templates 表中 tenant_id 命中的行数。 */
function countTemplatesByTenant(db: IDatabase, tenantId: string): number {
  return Number(
    db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_templates WHERE tenant_id = ?')
      .get(tenantId)!.c,
  );
}

describe('PersonaTemplateService 分片探针', () => {
  let s1: IDatabase;
  let s2: IDatabase;

  beforeEach(() => {
    s1 = tplDb();
    s2 = tplDb();
  });

  it('1. CRUD per-tenant 分流对称：tA→shard1、tB→shard2，各自 create 落对应 shard，跨 shard 查不到', () => {
    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2' },
    });
    const service = stack(resolver);

    const tplA = service.create('tenant_a', { category: 'engineer', label: 'A 工程师' });
    const tplB = service.create('tenant_b', { category: 'sales', label: 'B 销售' });

    /* 正向：各自落在自己的 shard。 */
    assert.equal(countTemplatesByTenant(s1, 'tenant_a'), 1);
    assert.equal(countTemplatesByTenant(s2, 'tenant_b'), 1);

    /* 对称：跨 shard 查不到（tenant_a 的模板不在 s2，反之亦然）——证分流双向不串。 */
    assert.equal(countTemplatesByTenant(s2, 'tenant_a'), 0);
    assert.equal(countTemplatesByTenant(s1, 'tenant_b'), 0);

    /* 经服务读路径确认（非仅裸 SQL）：各租户 list 只看到自己的自定义模板。 */
    const listA = service.list('tenant_a').filter((t) => !t.isBuiltIn);
    const listB = service.list('tenant_b').filter((t) => !t.isBuiltIn);
    assert.deepEqual(listA.map((t) => t.id), [tplA.id]);
    assert.deepEqual(listB.map((t) => t.id), [tplB.id]);
  });

  it('2. syncBuiltins 每 shard 一份（核心）：两 shard 的 persona_templates 都有全部内置模板', () => {
    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2' },
    });
    const service = stack(resolver);

    service.syncBuiltins();

    /* 两个 shard 的 persona_templates 都有全部 tenant_id='__builtin__' 行。 */
    assert.equal(countTemplatesByTenant(s1, BUILTIN_TENANT_ID), BUILTIN_TEMPLATE_SEEDS.length, 'shard1 全部内置模板');
    assert.equal(countTemplatesByTenant(s2, BUILTIN_TENANT_ID), BUILTIN_TEMPLATE_SEEDS.length, 'shard2 全部内置模板');

    /* list(tA)（tA→shard1）/ list(tB)（tB→shard2）各能查到内置——证每 shard 都有内置，
     * 单-SQL `OR '__builtin__'` 查询模型成立。 */
    const builtinsA = service.list('tenant_a').filter((t) => t.isBuiltIn);
    const builtinsB = service.list('tenant_b').filter((t) => t.isBuiltIn);
    assert.equal(builtinsA.length, BUILTIN_TEMPLATE_SEEDS.length);
    assert.equal(builtinsB.length, BUILTIN_TEMPLATE_SEEDS.length);
  });

  it('3. instantiate 级联同 shard（核心，证 template/core resolver 一致）', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2' },
    });
    const service = stack(resolver);
    service.syncBuiltins();

    const result = service.instantiate({
      tenantId: 'tenant_a',
      ownerUserId: 'tenant_a_owner',
      templateId: 'tpl_builtin_customer_service',
      displayName: 'A 客服-001',
    });

    /* shard1 有：模板（内置，syncBuiltins 已刷）+ 新建 persona_core 行 + audit_log 行——
     * 全落 shard1 同一 shard（template/audit 经 forTenant，persona 经共享 resolver 的
     * personaCoreService.createPersona）。 */
    const onShard1 = PersonaCoreService.fromUnitOfWork(s1);
    const detail = onShard1.getPersonaDetail('tenant_a', 'tenant_a_owner', result.persona.id);
    assert.ok(detail, 'persona_core 行落 shard1');

    const auditRows = s1.prepare<{ target_id: string }>(
      `SELECT target_id FROM audit_log
        WHERE event_kind = 'business' AND action_type = 'persona_template.instantiated'`,
    ).all();
    assert.equal(auditRows.length, 1, 'audit_log 行落 shard1');
    assert.equal(auditRows[0].target_id, result.persona.id);

    /* 跨 shard 查不到：shard2 上一个都没有——证不是"两边都有"的假阳性。 */
    const onShard2 = PersonaCoreService.fromUnitOfWork(s2);
    assert.equal(onShard2.getPersonaDetail('tenant_a', 'tenant_a_owner', result.persona.id), null);
    const auditOnShard2 = s2.prepare<{ c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log WHERE action_type = 'persona_template.instantiated'`,
    ).get()!.c;
    assert.equal(Number(auditOnShard2), 0);
  });

  it('4. syncBuiltins 任一 shard 失败则抛（坏 shard 居中）：整体抛 + 前后健康 shard 都被尝试', () => {
    const s3 = tplDb();
    const bad = throwingDb({ on: 'execute' });

    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: bad, shard3: s3 },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2', tenant_c: 'shard3' },
    });
    const service = stack(resolver);

    assert.throws(
      () => service.syncBuiltins(),
      /syncBuiltins 部分 shard 失败/,
      'syncBuiltins 整体抛（非静默隔离）',
    );

    /* 坏 shard 前后的健康 shard（shard1、shard3）都已被尝试并刷入全部内置——
     * 证遍历未因居中失败就提前停止。 */
    assert.equal(countTemplatesByTenant(s1, BUILTIN_TENANT_ID), BUILTIN_TEMPLATE_SEEDS.length, 'shard1（坏 shard 之前）已刷');
    assert.equal(countTemplatesByTenant(s3, BUILTIN_TENANT_ID), BUILTIN_TEMPLATE_SEEDS.length, 'shard3（坏 shard 之后）已刷');
  });

  it('5. syncBuiltins 升级半成功 → 重跑收敛：换掉坏 shard 后重跑不抛 + 全 shard 内置一致', () => {
    const bad = throwingDb({ on: 'execute' });
    const resolverWithBad = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: bad },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2' },
    });
    const serviceWithBad = stack(resolverWithBad);

    assert.throws(() => serviceWithBad.syncBuiltins(), /syncBuiltins 部分 shard 失败/);
    /* 部分成功：shard1 已刷、shard2（坏）未刷。 */
    assert.equal(countTemplatesByTenant(s1, BUILTIN_TENANT_ID), BUILTIN_TEMPLATE_SEEDS.length);

    /* 模拟恢复：把坏 shard 换成正常 db，重跑 syncBuiltins()。 */
    const resolverRecovered = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2' },
    });
    const serviceRecovered = stack(resolverRecovered);

    assert.doesNotThrow(() => serviceRecovered.syncBuiltins(), '重跑不抛（upsert 幂等收敛）');

    /* 全 shard 内置模板一致。 */
    assert.equal(countTemplatesByTenant(s1, BUILTIN_TENANT_ID), BUILTIN_TEMPLATE_SEEDS.length, 'shard1 仍全量');
    assert.equal(countTemplatesByTenant(s2, BUILTIN_TENANT_ID), BUILTIN_TEMPLATE_SEEDS.length, 'shard2 收敛到全量');
  });

  it('6. UoW 模式：fromUnitOfWork(db, core)，CRUD + instantiate 落该 db', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    const core = PersonaCoreService.fromUnitOfWork(s1);
    const service = PersonaTemplateService.fromUnitOfWork(s1, core);

    service.syncBuiltins();
    assert.equal(countTemplatesByTenant(s1, BUILTIN_TENANT_ID), BUILTIN_TEMPLATE_SEEDS.length);

    const tpl = service.create('tenant_a', { category: 'hr', label: 'A HR' });
    assert.equal(countTemplatesByTenant(s1, 'tenant_a'), 1);
    assert.ok(service.get('tenant_a', tpl.id));

    const result = service.instantiate({
      tenantId: 'tenant_a',
      ownerUserId: 'tenant_a_owner',
      templateId: 'tpl_builtin_hr',
      displayName: 'A HR-001',
    });
    /* forTenant 忽略 tenantId 恒返绑定的 tx（s1）——即便传别的 tenantId 也解析到同一 db。 */
    const detail = PersonaCoreService.fromUnitOfWork(s1).getPersonaDetail('tenant_a', 'tenant_a_owner', result.persona.id);
    assert.ok(detail, 'UoW 模式：instantiate 落该 db');
  });

  it('7. 单库零回归：fromResolver(SingleDbResolver(db)) 行为与改造前等价', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    const service = stack(new SingleDbResolver(s1));

    service.syncBuiltins();
    const builtins = service.list('tenant_a').filter((t) => t.isBuiltIn);
    assert.equal(builtins.length, BUILTIN_TEMPLATE_SEEDS.length);

    const tpl = service.create('tenant_a', { category: 'finance', label: 'A 财务' });
    assert.equal(service.get('tenant_a', tpl.id)?.label, 'A 财务');

    const result = service.instantiate({
      tenantId: 'tenant_a',
      ownerUserId: 'tenant_a_owner',
      templateId: 'tpl_builtin_finance',
      displayName: 'A 财务-001',
    });
    assert.ok(result.persona.id.startsWith('pcore_'));
    assert.equal(result.instantiatedFromCategory, 'finance');

    const auditRows = s1.prepare<{ c: number }>(
      `SELECT COUNT(*) AS c FROM audit_log WHERE action_type = 'persona_template.instantiated'`,
    ).get()!.c;
    assert.equal(Number(auditRows), 1, '单库模式下审计行为与改造前等价');
  });

  it('8. update/delete TOCTOU 既有语义回归：get（读）+ execute（写）落同一 db，行为等价改造前', () => {
    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1' },
    });
    const service = stack(resolver);

    const tpl = service.create('tenant_a', { category: 'legal', label: 'A 法务' });

    /* update：入口解析一次 db（shard1），get+execute 同 db——落 shard1，不落 shard2。 */
    const updated = service.update('tenant_a', tpl.id, { label: 'A 法务（更新）' });
    assert.equal(updated.label, 'A 法务（更新）');
    const rowAfterUpdate = s1.prepare<{ label: string }>(
      'SELECT label FROM persona_templates WHERE tenant_id = ? AND id = ?',
    ).get('tenant_a', tpl.id);
    assert.equal(rowAfterUpdate?.label, 'A 法务（更新）', '更新落 shard1（get+execute 同 db）');
    assert.equal(countTemplatesByTenant(s2, 'tenant_a'), 0, 'shard2 无任何该租户模板（未裂脑写错 shard）');

    /* delete：同样入口解析一次 db，get+execute 同 db。 */
    service.delete('tenant_a', tpl.id);
    assert.equal(service.get('tenant_a', tpl.id), null);
    const rowAfterDelete = s1.prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM persona_templates WHERE tenant_id = ? AND id = ?',
    ).get('tenant_a', tpl.id)!.c;
    assert.equal(Number(rowAfterDelete), 0, '删除落 shard1');
  });
});
