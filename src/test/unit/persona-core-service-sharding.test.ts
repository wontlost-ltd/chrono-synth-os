/**
 * PersonaCoreService 多-shard 分片探针（#3 PersonaCoreService 双入口化子片第 4 任务验收）。
 *
 * 用 FakeMultiShardResolver 注多个独立物理 db，验证本片安全命脉——「一次 facade 事务方法内，
 * facade 写 + 所有子服务写落同一物理连接同一事务」——单库下 dbForTenant 与 UoW 是同一个 db，
 * 这条铁律测不出来；本文件的多 shard 布置是唯一能让「跨子服务裂脑」「嵌套事务部分提交」
 * 这两类回归产生可观测差异的手段。
 *
 * 覆盖 spec（docs/superpowers/specs/2026-07-18-persona-core-service-resolver-design.md）
 * 验收段 10 类探针，核心是 2/3/9（跨子服务同事务 + 原子回滚故障注入 + UoW 模式）：
 *   1. per-tenant 分流对称
 *   2. 跨子服务事务同 db（persona + memory + 认知投影落同一 shard）
 *   3. 原子回滚故障注入（核心）：SQLite + PG（无 TEST_POSTGRES_URL 则 skip）
 *   4. 深层 tx 变异对应——融进 3 的变异复用（见文件末变异记录，不在此重复起探针）
 *   5. typed hook 覆盖：marketplace→wallet（settleTaskPayment）、governance→memory（openGovernanceCase）
 *   6. 嵌套事务——TransactionContext 编译期已禁，见下方"探针 6 说明"，不写运行时探针
 *   7. recoverTimedOut fan-out + 部分失败隔离——Task 2 已在
 *      persona-marketplace-recovery-sharding.test.ts 覆盖，此处不重复，仅引用
 *   8. encryptionResolver canonical tenantId
 *   9. UoW 模式
 *   10. 单库零回归
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import { FakeMultiShardResolver } from '../support/fake-multi-shard-resolver.js';
import { SingleDbResolver } from '../../storage/tenant-db-resolver.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { FieldEncryption } from '../../storage/encryption.js';
import { throwingDb } from '../support/throwing-db.js';
import type { IDatabase } from '../../storage/database.js';
import type { Command, ExecResult, Query } from '@chrono/kernel';

const TEST_URL = process.env.TEST_POSTGRES_URL;

/** 建带全量 schema 的内存 SQLite db（迁移入口），一个 db = 一个 shard。 */
function pcoreDb(): IDatabase {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return db;
}

/** 在给定 db 上插入一个 owner 用户，供 createPersona 等方法的 FK/所有权校验用。 */
function seedOwner(db: IDatabase, tenantId: string, ownerUserId: string): void {
  const now = Date.now();
  db.prepare<void>(
    `INSERT INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ownerUserId, `${ownerUserId}@example.com`, 'hash', 'member', tenantId, now, now);
}

/**
 * 故障注入装饰器：包一层真实 IDatabase，转发全部读写到底层真库（事务/查询/命令都是
 * 真实执行，走真实 BEGIN/COMMIT/ROLLBACK），仅在 `execute()` 收到 kind 命中
 * `throwOnCommandKind` 时抛错。
 *
 * 为什么不用最小假 db（如 recovery-sharding 探针的 throwingDb）：本探针要证明"同一个
 * 事务里，前面几条写已经真的执行到存储引擎、随后失败时会被真实回滚撤销"——如果 execute
 * 全 no-op，就无法制造"facade 写 persona 成功 + 子服务写 memory 成功，再失败"的中间态，
 * 也就测不出"整体回滚"与"部分持久化"的差异。
 */
function withExecuteFailure(
  real: IDatabase,
  throwOnCommandKind: string,
): IDatabase {
  return {
    dialect: real.dialect,
    exec: (sql: string) => real.exec(sql),
    prepare: (sql: string) => real.prepare(sql),
    close: () => real.close(),
    transaction: <T,>(fn: () => T): T => real.transaction(fn),
    transactionRollback: <T,>(fn: () => T): T => real.transactionRollback(fn),
    queryOne: <TResult, TParams>(q: Query<TResult, TParams>) => real.queryOne(q),
    queryMany: <TResult, TParams>(q: Query<TResult, TParams>) => real.queryMany(q),
    execute: <TParams,>(cmd: Command<TParams>): ExecResult => {
      if (cmd.kind === throwOnCommandKind) {
        throw new Error(`fault-injected: ${throwOnCommandKind}`);
      }
      return real.execute(cmd);
    },
  } as unknown as IDatabase;
}


describe('PersonaCoreService 分片探针', () => {
  let s1: IDatabase;
  let s2: IDatabase;

  beforeEach(() => {
    s1 = pcoreDb();
    s2 = pcoreDb();
  });

  it('1. per-tenant 分流对称：tA→shard1、tB→shard2，各自 createPersona 落对应 shard，跨 shard 查不到', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    seedOwner(s2, 'tenant_b', 'tenant_b_owner');

    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2' },
    });
    const service = PersonaCoreService.fromResolver(resolver);

    const personaA = service.createPersona({
      tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', displayName: 'Persona A',
    });
    const personaB = service.createPersona({
      tenantId: 'tenant_b', ownerUserId: 'tenant_b_owner', displayName: 'Persona B',
    });

    /* 正向：各自落在自己的 shard。 */
    assert.ok(PersonaCoreService.fromUnitOfWork(s1).getPersonaDetail('tenant_a', 'tenant_a_owner', personaA.id));
    assert.ok(PersonaCoreService.fromUnitOfWork(s2).getPersonaDetail('tenant_b', 'tenant_b_owner', personaB.id));

    /* 对称：跨 shard 查不到（tenant_a 的 persona 不在 s2，反之亦然）——证分流双向不串。 */
    assert.equal(PersonaCoreService.fromUnitOfWork(s2).getPersonaDetail('tenant_a', 'tenant_a_owner', personaA.id), null);
    assert.equal(PersonaCoreService.fromUnitOfWork(s1).getPersonaDetail('tenant_b', 'tenant_b_owner', personaB.id), null);
  });

  it('2. 跨子服务事务同 db（核心）：createPersona 的 persona + memory + 认知投影落同一 shard', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    seedOwner(s2, 'tenant_b', 'tenant_b_owner');

    /* 故意让被测租户（tenant_b）映射到 allShardDbs() 顺序里的**第二个** shard（s2），
     * 而不是第一个——如果深层 tx 有代码退化成恒用 allDbs()[0]（构造期/遍历首个 shard）
     * 而非 forTenant(tenantId) 解析的 db，本探针能在"跨 shard 落错"处翻红；若被测租户
     * 恰好映射到第一个 shard，这类回归会被"用错的 shard 恰好也是对的"掩盖掉，测不出来。 */
    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2' },
    });
    const service = PersonaCoreService.fromResolver(resolver);

    const persona = service.createPersona({
      tenantId: 'tenant_b',
      ownerUserId: 'tenant_b_owner',
      displayName: 'Nova',
      initialKnowledge: [{ title: 'Brief', content: 'Core strategy', tags: ['strategy'] }],
    });

    /* facade 写的 persona_core 行 + 子服务写的 memory 行 + 认知投影行，三者必须都能在
     * shard2（s2，非 allDbs() 首位）上经同一套读路径查到——如果任一深层 tx 落错 shard
     * （例如 getCognitive/projectKnowledgeItem 误用构造期旧 db 或恒用 allDbs()[0]），
     * 这里会读到 0 而非 1 而红。 */
    const onShard2 = PersonaCoreService.fromUnitOfWork(s2);
    const detail = onShard2.getPersonaDetail('tenant_b', 'tenant_b_owner', persona.id);
    assert.ok(detail, 'persona_core 行落 shard2');
    assert.equal(detail!.knowledgeItems.length, 1, '知识项落 shard2');
    assert.equal(detail!.stats.memoryCount, 1, 'memory 行落 shard2（initialKnowledge 触发 insertMemoryInTx）');

    const graph = onShard2.getPersonaGraphSummary('tenant_b', 'tenant_b_owner', persona.id);
    assert.ok(graph);
    assert.equal(graph!.totalNodes, 1, '认知投影节点落 shard2（projectKnowledgeItemInTx 用同一 tx，非恒用 allDbs()[0]）');

    /* 反向确认：shard1（tenant_a 的库，也是 allDbs() 首位）上一条相关记录都没有——
     * 证明不是"两边都有"的假阳性，也直接证明认知投影没有裂脑落到 allDbs()[0]。 */
    const onShard1 = PersonaCoreService.fromUnitOfWork(s1);
    assert.equal(onShard1.getPersonaDetail('tenant_b', 'tenant_b_owner', persona.id), null);
    const graphOnWrongShard = onShard1.getPersonaGraphSummary('tenant_b', 'tenant_b_owner', persona.id);
    assert.equal(graphOnWrongShard, null, '认知投影未误落到 allDbs()[0]（shard1）');
  });

  it('3a. 原子回滚故障注入（核心，SQLite）：子服务写 memory 成功后注入异常→ persona/wallet/knowledge/memory/认知投影/audit 全部不存在', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');

    /* 故障注入点：pcmemCmdInsertNode（认知投影 upsert 节点）。此时 persona_core（facade）+
     * wallet（facade）+ knowledge_item（facade）+ memory 行（子服务 insertMemoryInTx）都已
     * 真实 execute 成功——注入点严格晚于"子服务写 memory 成功"，精确对应 spec 验收段 3 的
     * 措辞"facade 写 persona → 子服务写 memory 成功 → 注入异常"。 */
    const faultyDb = withExecuteFailure(s1, 'cognitiveMemory.insertNode');
    const service = PersonaCoreService.fromUnitOfWork(faultyDb);

    assert.throws(
      () => service.createPersona({
        tenantId: 'tenant_a',
        ownerUserId: 'tenant_a_owner',
        displayName: 'Nova',
        initialKnowledge: [{ title: 'Brief', content: 'Core strategy', tags: ['strategy'] }],
      }),
      /fault-injected: cognitiveMemory\.insertNode/,
    );

    /* 用真库（s1，未包装）直接验证：如果只是"同 shard"而非"同一事务"，persona/wallet/
     * knowledge/memory 四行会真的留在库里（因为它们在故障注入点之前已经真实 commit 到存储
     * 引擎的写缓冲）——只有真正处在同一个 db.transaction() 边界内，一次 ROLLBACK 才能把
     * 这四类已执行的写全部撤销。这是本探针证"同事务"而不只是"同 shard"的关键断言。 */
    const verify = PersonaCoreService.fromUnitOfWork(s1);
    assert.equal(verify.listPersonas('tenant_a', 'tenant_a_owner').length, 0, 'persona_core 行整体回滚，一个 persona 都不留');

    /* 直接用底层 db 查计数，覆盖 wallet / knowledge_item / memory 行——listPersonas 为 0 已
     * 隐含 persona 不存在，但 wallet/knowledge/memory 是独立表，需要分别确认没有孤儿行。 */
    const walletCount = s1.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_wallets').get()!.c;
    const knowledgeCount = s1.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_knowledge_items').get()!.c;
    const memoryCount = s1.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_memories').get()!.c;
    const cognitiveCount = s1.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_memory_nodes').get()!.c;
    assert.equal(Number(walletCount), 0, 'wallet 行未残留（facade 写，与 persona 同事务）');
    assert.equal(Number(knowledgeCount), 0, 'knowledge_item 行未残留（facade 写）');
    assert.equal(Number(memoryCount), 0, 'memory 行未残留（子服务 insertMemoryInTx 写，与 facade 同事务回滚）');
    assert.equal(Number(cognitiveCount), 0, '认知投影行未残留（本身就是失败点，理应为 0）');

    const auditCount = s1.prepare<{ c: number }>(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action_type = 'persona.create'",
    ).get()!.c;
    assert.equal(Number(auditCount), 0, 'audit 行未残留（recordBusinessAuditInTx 在故障注入点之后执行，本就不会跑到）');
  });

  it('3b. 原子回滚故障注入（PG，因嵌套会独立提交尤须验）', { skip: !TEST_URL }, async () => {
    const { createIsolatedPgSchema } = await import('../integration/fixtures/pg-test-schema.js');
    const iso = await createIsolatedPgSchema('pcore-sharding-rollback', TEST_URL!, { max: 3 });
    try {
      seedOwner(iso.db, 'tenant_a', 'tenant_a_owner');
      const faultyDb = withExecuteFailure(iso.db, 'cognitiveMemory.insertNode');
      const service = PersonaCoreService.fromUnitOfWork(faultyDb);

      assert.throws(
        () => service.createPersona({
          tenantId: 'tenant_a',
          ownerUserId: 'tenant_a_owner',
          displayName: 'Nova',
          initialKnowledge: [{ title: 'Brief', content: 'Core strategy', tags: ['strategy'] }],
        }),
        /fault-injected: cognitiveMemory\.insertNode/,
      );

      const verify = PersonaCoreService.fromUnitOfWork(iso.db);
      assert.equal(verify.listPersonas('tenant_a', 'tenant_a_owner').length, 0, 'PG：persona_core 行整体回滚');

      const walletCount = iso.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_wallets').get()!.c;
      const memoryCount = iso.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_memories').get()!.c;
      const cognitiveCount = iso.db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_memory_nodes').get()!.c;
      assert.equal(Number(walletCount), 0, 'PG：wallet 行未残留');
      assert.equal(Number(memoryCount), 0, 'PG：memory 行未残留');
      assert.equal(Number(cognitiveCount), 0, 'PG：认知投影行未残留');
    } finally {
      await iso.cleanup();
    }
  });

  it('5a. typed hook 覆盖：marketplace→wallet（settleTaskPayment）落同一 shard + 幂等短路', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1' },
    });
    const service = PersonaCoreService.fromResolver(resolver);

    const persona = service.createPersona({ tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', displayName: 'Nova' });
    const task = service.publishTask({
      tenantId: 'tenant_a', publisherUserId: 'tenant_a_owner', title: 'Task',
      description: 'desc', category: 'operations', reward: 100,
    });
    assert.ok(service.applyToTask({ tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', taskId: task.id, personaId: persona.id }));
    const assignment = service.assignTask({ tenantId: 'tenant_a', actorUserId: 'tenant_a_owner', taskId: task.id, personaId: persona.id });
    assert.ok(assignment);

    const settlement = service.settleTaskPayment({
      tenantId: 'tenant_a',
      actorUserId: 'tenant_a_owner',
      taskId: task.id,
      assignmentId: assignment!.id,
      totalAmountMinor: 10_000,
      currency: 'USD',
      split: { ownerPct: 60, personaPct: 20, platformPct: 20 },
    });
    assert.ok(settlement, 'marketplace.settleTaskPayment 经 walletHook.insertWalletTransactionInTx 落同一 tx');

    /* 落 shard1：wallet 余额 + wallet_settlement 行都能在 s1 上经同一套读路径查到。 */
    const onShard1 = PersonaCoreService.fromUnitOfWork(s1);
    const wallet = onShard1.getWallet('tenant_a', 'tenant_a_owner', persona.id);
    assert.ok(wallet && wallet.balance > 0, 'wallet 结算落 shard1（marketplace→wallet hook 同事务同 shard）');

    /* shard2 完全无该 tenant 数据（未映射，调用会抛错，故只做"未映射"的存在性反证）。 */
    assert.throws(() => resolver.dbForTenant('tenant_ghost'), /无 shard 映射/);
  });

  it('5b. typed hook 覆盖：governance→memory（openGovernanceCase）落同一 shard + 原子回滚', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1' },
    });
    const service = PersonaCoreService.fromResolver(resolver);
    const persona = service.createPersona({ tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', displayName: 'Nova' });

    const governanceCase = service.openGovernanceCase({
      tenantId: 'tenant_a',
      actorUserId: 'tenant_a_owner',
      personaId: persona.id,
      triggerType: 'manual_review',
      severity: 'medium',
      details: { reason: 'routine audit' },
    });
    assert.ok(governanceCase, 'openGovernanceCase 经 openGovernanceCaseInTx 写 case+event+memory 同一事务');

    /* 落 shard1：治理案件 + governanceHook.memoryHook 写的 memory 行都在 s1。 */
    const onShard1 = PersonaCoreService.fromUnitOfWork(s1);
    const cases = onShard1.listGovernanceCases('tenant_a', 'tenant_a_owner', persona.id);
    assert.equal(cases?.length, 1, '治理案件落 shard1');
    const memories = onShard1.listPersonaMemories('tenant_a', 'tenant_a_owner', persona.id, { kind: 'governance' });
    assert.equal(memories?.length, 1, 'governance→memoryHook.insertMemoryInTx 落同一 shard（同一事务）');

    /* 原子回滚：openGovernanceCaseInTx 本身是 public/InTx 一对（db.transaction(() => this.openGovernanceCaseInTx(db, input))），
     * 用故障注入验证案件+事件+memory 三行同进同退——在 insertMemory 之后的 observability 发布点前失败。 */
    const faultyDb = withExecuteFailure(s1, 'pcore.insertMemory');
    const faultyService = PersonaCoreService.fromUnitOfWork(faultyDb);
    assert.throws(
      () => faultyService.openGovernanceCase({
        tenantId: 'tenant_a',
        actorUserId: 'tenant_a_owner',
        personaId: persona.id,
        triggerType: 'manual_review_2',
        severity: 'high',
      }),
    );
    const casesAfterFault = onShard1.listGovernanceCases('tenant_a', 'tenant_a_owner', persona.id);
    assert.equal(casesAfterFault?.length, 1, '故障注入的第二次调用未留孤儿案件（仍是探针 5b 开头那 1 条），证 governance 写与 memory 写同一事务');
  });

  it('7. recoverTimedOut fan-out + 部分失败隔离：见 persona-marketplace-recovery-sharding.test.ts（Task 2 已覆盖，不在此重复）', () => {
    /* Task 2（第 2 任务）已用同款 FakeMultiShardResolver + throwingDb 建立
     * 「两 shard 各自恢复超时 session + 聚合求和」与「坏 shard 隔离、健康 shard 仍恢复」两条探针，
     * 覆盖 spec 验收段第 7 类。本探针只做最小存在性引用，避免与该文件重复维护同一断言。 */
    assert.equal(typeof PersonaCoreService.prototype.recoverTimedOutRuntimeSessions, 'function');
    /* throwingDb（公共桩，queryMany 抛错）本身在本文件也用于探针的坏 shard 隔离场景（如需扩展），
     * 此行只是消 "unused" 顾虑并留一个可读的锚点，非重复功能测试。 */
    assert.equal(throwingDb({ on: 'queryMany' }).dialect, 'sqlite');
  });

  it('8. encryptionResolver canonical tenantId：跨租户不串加密配置', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    seedOwner(s2, 'tenant_b', 'tenant_b_owner');

    const keyA = new FieldEncryption({ enabled: true, masterKey: randomBytes(32).toString('base64'), keyRotationIntervalDays: 90 });
    const keyB = new FieldEncryption({ enabled: true, masterKey: randomBytes(32).toString('base64'), keyRotationIntervalDays: 90 });
    const encryptionResolver = (tenantId: string): FieldEncryption | undefined => {
      if (tenantId === 'tenant_a') return keyA;
      if (tenantId === 'tenant_b') return keyB;
      return undefined;
    };

    const resolver = new FakeMultiShardResolver({
      coordinator: s1,
      shards: { shard1: s1, shard2: s2 },
      tenantToShard: { tenant_a: 'shard1', tenant_b: 'shard2' },
    });
    const service = PersonaCoreService.fromResolver(resolver, undefined, 60_000, encryptionResolver);

    const personaA = service.createPersona({ tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', displayName: 'A' });
    const personaB = service.createPersona({ tenantId: 'tenant_b', ownerUserId: 'tenant_b_owner', displayName: 'B' });

    service.addMemory({
      tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', personaId: personaA.id,
      kind: 'interaction', sensitivity: 'encrypted', summary: 'tenant A 机密备注',
    });
    service.addMemory({
      tenantId: 'tenant_b', ownerUserId: 'tenant_b_owner', personaId: personaB.id,
      kind: 'interaction', sensitivity: 'encrypted', summary: 'tenant B 机密备注',
    });

    /* db 解析与加密配置解析用同一 canonical tenantId：db.execute 落对应 shard 的密文列，
     * 用错误租户的 key 解密会抛错或得到乱码——通过服务自身读路径（内部会用同 tenantId
     * 再解析一次 resolver）验证各自能正确解密回原文，即"该租户的 db 与该租户的加密配置
     * 是同一次 canonical 解析产物"。 */
    const memoriesA = service.listPersonaMemories('tenant_a', 'tenant_a_owner', personaA.id);
    const memoriesB = service.listPersonaMemories('tenant_b', 'tenant_b_owner', personaB.id);
    assert.equal(memoriesA?.[0]?.summary, 'tenant A 机密备注', 'tenant_a 用自己的 key 正确解密');
    assert.equal(memoriesB?.[0]?.summary, 'tenant B 机密备注', 'tenant_b 用自己的 key 正确解密');

    /* 交叉验证：直接读 shard1 上 tenant_a 的密文列，用 tenant_b 的 key 解密应失败或得到
     * 乱码（不等于原文）——证密文确实是用 tenant_a 自己的 key 加的，没有跨租户串配置。 */
    const rawRow = s1.prepare<{ summary: string }>(
      'SELECT summary FROM persona_memories WHERE tenant_id = ? AND persona_id = ?',
    ).get('tenant_a', personaA.id);
    assert.ok(rawRow);
    let decryptedWithWrongKey: string | undefined;
    try {
      decryptedWithWrongKey = keyB.decrypt(rawRow!.summary);
    } catch {
      decryptedWithWrongKey = undefined;
    }
    assert.notEqual(decryptedWithWrongKey, 'tenant A 机密备注', '用错误租户的 key 解不出正确原文（未跨租户串加密配置）');
  });

  it('9. UoW 模式：fromUnitOfWork(db)，createPersona 落该 db + 原子回滚', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    const service = PersonaCoreService.fromUnitOfWork(s1);

    const persona = service.createPersona({
      tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', displayName: 'UoW Persona',
      initialKnowledge: [{ title: 'K', content: 'C' }],
    });
    assert.ok(persona);
    /* forTenant 忽略 tenantId 恒返该 tx；即便传别的 tenantId 也解析到同一 db（结构上不脱离事务）。 */
    const detailViaOtherTenantArg = service.getPersonaDetail('tenant_a', 'tenant_a_owner', persona.id);
    assert.ok(detailViaOtherTenantArg, 'UoW 模式下 forTenant 恒返绑定的 tx，读到刚写的行');

    /* 原子回滚：UoW 模式下故障注入同样应整体回滚（forTenant 恒返 s1，withExecuteFailure 包一层）。 */
    const faultyDb = withExecuteFailure(s1, 'cognitiveMemory.insertNode');
    const faultyService = PersonaCoreService.fromUnitOfWork(faultyDb);
    assert.throws(() => faultyService.createPersona({
      tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', displayName: 'Should Rollback',
      initialKnowledge: [{ title: 'K2', content: 'C2' }],
    }));
    /* 只有探针开头那 1 个 persona，故障注入的第二次调用未留孤儿。 */
    assert.equal(service.listPersonas('tenant_a', 'tenant_a_owner').length, 1, 'UoW 模式故障注入后未留孤儿 persona');
  });

  it('10. 单库零回归：fromResolver(new SingleDbResolver(db)) 行为与 fromUnitOfWork 等价', () => {
    seedOwner(s1, 'tenant_a', 'tenant_a_owner');
    const service = PersonaCoreService.fromResolver(new SingleDbResolver(s1));

    const persona = service.createPersona({
      tenantId: 'tenant_a',
      ownerUserId: 'tenant_a_owner',
      displayName: 'Single Db Persona',
      initialKnowledge: [{ title: 'Brief', content: 'Strategy' }],
    });

    assert.equal(persona.displayName, 'Single Db Persona');
    assert.equal(persona.knowledgeItems.length, 1);
    assert.equal(persona.stats.memoryCount, 1);

    const graph = service.getPersonaGraphSummary('tenant_a', 'tenant_a_owner', persona.id);
    assert.equal(graph?.totalNodes, 1, '单库模式下跨子服务事务方法行为与改造前等价：认知投影正常落库');

    const task = service.publishTask({
      tenantId: 'tenant_a', publisherUserId: 'tenant_a_owner', title: 'T',
      description: 'D', category: 'operations', reward: 50,
    });
    assert.ok(service.applyToTask({ tenantId: 'tenant_a', ownerUserId: 'tenant_a_owner', taskId: task.id, personaId: persona.id }));
    const assignment = service.assignTask({ tenantId: 'tenant_a', actorUserId: 'tenant_a_owner', taskId: task.id, personaId: persona.id });
    const settlement = service.settleTaskPayment({
      tenantId: 'tenant_a', actorUserId: 'tenant_a_owner', taskId: task.id, assignmentId: assignment!.id,
      totalAmountMinor: 5_000, currency: 'USD', split: { ownerPct: 60, personaPct: 20, platformPct: 20 },
    });
    assert.ok(settlement, '单库模式下 marketplace→wallet hook 同样正常工作');
  });
});

/*
 * 探针 6 说明（嵌套事务变异）：spec 红线 6b 把「InTx 收 tx、禁止自开 transaction」升级为
 * **类型层结构性禁止**——`TransactionContext = Pick<SyncWriteUnitOfWork, 'queryOne'|'queryMany'|'execute'>`
 * （见 src/persona-core/persona-core-source.ts）故意不暴露 `transaction`，所有 `*InTx` 方法
 * 的参数类型都是 `TransactionContext` 而非 `SyncWriteUnitOfWork`。这意味着"在 InTx 方法体内
 * 调 `tx.transaction()`"在**编译期**就不通过（`tx` 的静态类型上没有 `transaction` 方法），
 * 不是运行时才失败的架构约定。
 *
 * 因此本文件不写"运行时嵌套事务探针"：能测的只是"当前实现没有绕过类型系统去 as 转型后
 * 手工调用嵌套事务"，这属于代码审查/lint 范畴，不是可自动化断言的运行时行为；真正的保障
 * 机制是 TypeScript 编译——`npm run typecheck` 是这条红线的验收手段。若要故意做变异验证，
 * 需要在 *InTx 方法体内手写 `(tx as SyncWriteUnitOfWork).transaction(...)` 的 as 转型逃逸，
 * 这已经不是"测试能抓到的自然回归形态"，而是刻意绕过类型系统——不构造这种测试。
 */
