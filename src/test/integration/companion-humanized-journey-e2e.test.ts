/**
 * 类人化全旅程 E2E（ADR-0056 六块协同的因果链）。
 *
 * 与 companion-chat-api.test.ts（逐块隔离样板）不同——本测试走**真实 createApp HTTP 栈** +
 * **真实注册登录（JWT）**，模拟一个用户与数字人多轮、跨天对话，端到端验证六块类人化
 * （mood/relationship/temporal/stance/variability/proactive）**协同的因果链**：
 *
 *   建立关系（我叫小明）→ 沉淀记忆+心情（聊开心的跑步）→ 观点+grounding（你觉得…好吗）
 *   → 回应变化性（同问多轮换措辞）→ 跨天重逢+主动回想（好久不见 + 我突然想到你说的跑步）
 *
 * 这条链**单块隔离测试无法证明**：它依赖真实 tenant 分发（register → 非 default tenantId →
 * tenantFactory.getTenantOS）+ 跨轮持久化（关系/心情/对话记忆落到正确 tenant 的 shared DB）+
 * 跨天时钟推进消费前几步留下的状态。
 *
 * 双环境：内存 SQLite（默认进 golden gate）+ 真实 Postgres（TEST_POSTGRES_URL，{skip:!URL}）。
 * 跑同一份 runHumanizedJourney(ctx)，只换 setup。
 *
 * 断言纪律（ADR-0047 可复现重定义：相同初态+时钟+输入序列→相同输出序列）：
 *   - 断「信号存在性」（含「好久不见」「我突然想到」「我觉得」）+「状态单调性」（>=），
 *     不断逐字 reply、不断精确 interactionCount、不断精确 mood 数值（Map 序/salience tie-break/
 *     时间回归会让逐字断言脆弱）。
 *   - mood 断言放在 clock.advance(5d) **之前**（6h 半衰期跨天回归中性）。
 *   - 不断 stance tentative（retrieval relevance=score/(score+4) 饱和，集成层难触发）；断 opinion。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import type { AppConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { CompanionRelationshipStore } from '../../storage/companion-relationship-store.js';
import { CompanionMoodStore } from '../../storage/companion-mood-store.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';
const DAY_MS = 24 * 60 * 60 * 1000;
/** companion 单用户人格固定 personaId（与 chat 路由 COMPANION_PERSONA_ID 对齐）。 */
const COMPANION_PERSONA_ID = 'default';

/** 旅程上下文：SQLite / PG 各构造一份，跑同一份 runHumanizedJourney。 */
interface JourneyCtx {
  readonly app: FastifyInstance;
  readonly os: ChronoSynthOS;
  readonly clock: TestClock;
  readonly db: IDatabase;
  /** 给某 tenant 的 persona core 种一条 semantic 知识（经 TenantOSFactory，写正确 tenant）。 */
  readonly seedTenantSemantic: (tenantId: string, content: string) => void;
  readonly label: 'sqlite' | 'postgres';
  readonly close: () => Promise<void>;
}

/** E2E 测试配置：关后台 worker / websocket，放宽 rateLimit，JWT 长 TTL（不依赖 TestClock 推断 JWT 时间）。 */
function testConfig(): AppConfig {
  return loadConfig({
    rateLimit: { max: 100_000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
    runtime: { recovery: { enabled: false } },
  });
}

/**
 * 构造一个与 createApp 内部同款的 TenantOSFactory，用于给**正确 tenant** 种 semantic 知识。
 * 真实注册用户的 chat 走 tenantFactory.getTenantOS(tid)（非 base os.core），所以种子必须经此路径
 * 才能被 chat 读到——这正是「seed base os 但 chat 读 tenant OS」假绿陷阱的规避法。
 */
function makeSeeder(db: IDatabase, clock: TestClock): (tenantId: string, content: string) => void {
  const factory = new TenantOSFactory(db, clock, new SilentLogger());
  return (tenantId: string, content: string) => {
    const tenantOS = factory.getTenantOS(tenantId);
    /* salience 高 → 稳定进 grounding；valence 中性，不污染 mood 断言。 */
    tenantOS.core.memories.addMemory('semantic', content, 0.3, 0.7);
  };
}

async function setupSqlite(): Promise<JourneyCtx> {
  const clock = new TestClock(1000);
  const os = new ChronoSynthOS({ clock, logger: new SilentLogger() });
  os.start();
  const db = os.getDatabase();
  const app = await createApp({ os, config: testConfig() });
  return {
    app, os, clock, db, label: 'sqlite',
    seedTenantSemantic: makeSeeder(db, clock),
    close: async () => { await app.close(); os.close(); },
  };
}

async function setupPostgres(url: string): Promise<JourneyCtx> {
  /* 每文件独立 schema 隔离（同其它 PG 集成测试）：CI 并行子进程共享同一 PG 库时，本文件若直接对
   * public 跑迁移会与并行 PG 测试撞 pg_extension/pg_type catalog + 残留表 already-exists。
   * helper 给本文件专属 schema + advisory-lock 串行化扩展创建；迁移落该 schema。 */
  const { createIsolatedPgSchema } = await import('./fixtures/pg-test-schema.js');
  const { db, cleanup } = await createIsolatedPgSchema('companion_journey', url);
  const clock = new TestClock(1000);
  /* 迁移由 helper 统一管理；os 用 skipMigrations:true 不再自迁（constructor 只会跑 SQLite runner）。 */
  const os = new ChronoSynthOS({ db, skipMigrations: true, clock, logger: new SilentLogger() });
  os.start();
  const app = await createApp({ os, db, config: testConfig() });
  return {
    app, os, clock, db, label: 'postgres',
    seedTenantSemantic: makeSeeder(db, clock),
    close: async () => { await app.close(); os.close(); await cleanup(); },
  };
}

/** 真实注册 → 拿 accessToken + tenantId（真实非 default tenant）。 */
async function registerAndGetAuth(app: FastifyInstance, email: string): Promise<{ accessToken: string; tenantId: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password: 'password123' } });
  assert.equal(res.statusCode, 201, `注册应 201：${res.body}`);
  return JSON.parse(res.body).data as { accessToken: string; tenantId: string };
}

interface ChatResult {
  readonly reply: string;
  readonly kind: string;
  readonly groundedMemoryCount: number;
}

/** 发一句 chat，返回解析后的结果（断 200）。 */
async function send(ctx: JourneyCtx, headers: Record<string, string>, message: string): Promise<ChatResult> {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/v1/companion/me/chat', headers, payload: { message },
  });
  assert.equal(res.statusCode, 200, `chat「${message}」应 200：${res.body}`);
  const data = JSON.parse(res.body).data as ChatResult;
  return data;
}

/** 抽离线脚注那一行（以「（」开头），用于变化性断言。 */
function offlineNoteOf(reply: string): string {
  return reply.split('\n').find((l) => /^（/.test(l)) ?? '';
}

/** 跑一个 COUNT(*) 并强转为 number（PG 的 COUNT 返回 bigint→string，SQLite 返回 number）。 */
function countRows(db: IDatabase, sql: string, ...params: ReadonlyArray<string>): number {
  const row = db.prepare<{ n: number | string }>(sql).get(...params);
  return Number(row?.n ?? 0);
}

/**
 * 一条主因果链（六阶段）。SQLite 与 PG 跑同一份。每个 assert 带中文消息说明验证哪一块/哪一步。
 */
async function runHumanizedJourney(ctx: JourneyCtx): Promise<void> {
  const { app, db, clock, seedTenantSemantic, label } = ctx;

  /* ── 阶段 1：建立关系（真实 auth/tenant 分发 + shared DB 落点）── */
  /* 邮箱用唯一值（randomUUID）——否则对**持久化**的 TEST_POSTGRES_URL 重跑会撞 users.email 唯一约束，
   * 第二次注册不再 201（Codex 复审：真实 PG 复跑稳定性）。唯一性不影响任何断言。 */
  const auth = await registerAndGetAuth(app, `journey-${label}-${randomUUID()}@test.com`);
  assert.notEqual(auth.tenantId, 'default', '阶段1：真实注册应分配非 default tenant（走 tenantFactory 路径）');
  const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

  const nameStep = await send(ctx, headers, '我叫小明');
  assert.equal(nameStep.kind, 'relationship', '阶段1：自报名字 → kind=relationship');
  assert.match(nameStep.reply, /小明/, '阶段1：回应带用户名');
  {
    const rel = new CompanionRelationshipStore(db, auth.tenantId, COMPANION_PERSONA_ID).get();
    assert.equal(rel.userName, '小明', '阶段1：用户名落到正确 tenant 的 shared DB');
  }

  /* ── 阶段 2：种下记忆 + 心情（本轮 HTTP 之后末尾沉淀 + 真实 tenant 落点）── */
  for (let i = 0; i < 5; i++) {
    await send(ctx, headers, '我今天好开心，特别喜欢清晨跑步，太棒了，谢谢你！');
  }
  {
    const { mood } = new CompanionMoodStore(db, auth.tenantId, COMPANION_PERSONA_ID).get();
    assert.ok(mood.valence > 0, `阶段2：聊开心事后 mood.valence>0（实际 ${mood.valence}）`);
    /* 对话沉淀的 episodic 记忆落到当前 tenant（ADR-0055 对话即经历）。 */
    const episodicCount = countRows(
      db, `SELECT COUNT(*) AS n FROM memory_nodes WHERE tenant_id = ? AND kind = 'episodic'`, auth.tenantId,
    );
    assert.ok(episodicCount >= 1, '阶段2：对话沉淀为 episodic 记忆，落到当前 tenant');
  }

  /* ── 阶段 3：观点 + 心情 + grounding 同时拼装 ── */
  /* 种两条 tenant semantic 让评价类问题够底气表态（stance opinion 需 count>=2）。 */
  seedTenantSemantic(auth.tenantId, '清晨跑步能帮助保持一天的节奏感');
  seedTenantSemantic(auth.tenantId, '清晨跑步让空气更清新，体验很好');
  const opinionStep = await send(ctx, headers, '你觉得清晨跑步好吗？');
  assert.equal(opinionStep.kind, 'knowledge_grounded', '阶段3：评价类问题有依据 → knowledge_grounded');
  assert.match(opinionStep.reply, /我觉得/, '阶段3：评价类问题带观点前缀（stance opinion）');
  assert.ok(opinionStep.groundedMemoryCount >= 1, '阶段3：确有引用记忆');

  /* ── 阶段 4：回应变化性（interactionCount 推动 variability seed）── */
  const notes = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const r = await send(ctx, headers, '你觉得清晨跑步好吗？');
    assert.equal(r.kind, 'knowledge_grounded', '阶段4：同问仍 grounded');
    notes.add(offlineNoteOf(r.reply));
  }
  assert.ok(notes.size >= 2, `阶段4：多轮出现 ≥2 种脚注措辞，不复读（实际 ${notes.size}）`);

  /* ── 阶段 5：跨天重逢 + 主动回想（依赖前几步持久化的关系状态 + 对话沉淀）── */
  clock.advance(5 * DAY_MS);
  const reunionStep = await send(ctx, headers, '清晨跑步有什么好处？');
  assert.match(reunionStep.reply, /好久不见/, '阶段5：跨天 >3 天 → 时间感知问候「好久不见」（用旧 last_seen 算）');
  assert.match(reunionStep.reply, /认识 5 天/, '阶段5：报出认识天数');
  assert.match(reunionStep.reply, /我突然想到/, '阶段5：主动回想（proactive callback）');
  assert.match(reunionStep.reply, /跑步/, '阶段5：回想到你之前说过的具体内容');

  /* ── 阶段 6：白盒收尾（真实持久化 + 租户隔离）── */
  {
    const rel = new CompanionRelationshipStore(db, auth.tenantId, COMPANION_PERSONA_ID).get();
    assert.ok(rel.interactionCount >= 11, `阶段6：互动次数累计（1名字+5开心+1观点+4变化+1重逢=12，>=11 容错；实际 ${rel.interactionCount}）`);
    assert.ok(rel.firstMetAt !== null && rel.lastSeenAt !== null, '阶段6：首次/最近时间已记');
    assert.ok((rel.lastSeenAt! - rel.firstMetAt!) >= 5 * DAY_MS, '阶段6：跨天后 last_seen-first_met >= 5 天');
    /* 租户隔离：别的 tenant 查不到「跑步」对话记忆。 */
    const otherTenantHits = countRows(
      db, `SELECT COUNT(*) AS n FROM memory_nodes WHERE tenant_id = ? AND content LIKE '%跑步%'`, 'some-other-tenant-id',
    );
    assert.equal(otherTenantHits, 0, '阶段6：跑步记忆只在当前 tenant，别的 tenant 隔离查不到');
    /* 反向确认当前 tenant 确有「跑步」记忆（避免 LIKE 在两个 tenant 都是 0 的假绿）。 */
    const currentTenantHits = countRows(
      db, `SELECT COUNT(*) AS n FROM memory_nodes WHERE tenant_id = ? AND content LIKE '%跑步%'`, auth.tenantId,
    );
    assert.ok(currentTenantHits >= 1, '阶段6：当前 tenant 确有跑步记忆（隔离断言非空对照）');
  }
}

/* ── SQLite（默认进 golden gate）── */
describe('类人化全旅程 E2E（SQLite 内存）', () => {
  let ctx: JourneyCtx;
  before(async () => { ctx = await setupSqlite(); });
  after(async () => { await ctx.close(); });

  it('真实注册→多轮→跨天：六块类人化协同的因果链全跑通', async () => {
    await runHumanizedJourney(ctx);
  });
});

/* ── 真实 Postgres（TEST_POSTGRES_URL 时跑，否则 skip）── */
const PG_URL = process.env.TEST_POSTGRES_URL;
describe('类人化全旅程 E2E（真实 Postgres）', { skip: !PG_URL }, () => {
  let ctx: JourneyCtx;
  before(async () => { ctx = await setupPostgres(PG_URL!); });
  after(async () => { await ctx.close(); });

  it('真实注册→多轮→跨天：六块类人化协同的因果链全跑通（PG 真实持久化/隔离）', async () => {
    await runHumanizedJourney(ctx);
  });
});
