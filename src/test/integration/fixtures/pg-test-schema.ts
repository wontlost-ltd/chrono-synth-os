/**
 * PG 集成测试的「每文件独立 schema」隔离 helper。
 *
 * 背景（修复 pre-existing flaky bug）：CI 用 `node --test dist/test/integration/**` 把所有集成测试
 * 以**并行子进程**跑（Node 24 默认并发=CPU 数），而多个 PG 测试文件**共享同一个数据库**。
 * 各文件原先在 `before` 里 `DROP SCHEMA public CASCADE` / 或枚举固定表名 drop，于是：
 *   ① 并行：两个文件同时重置 public schema → `CREATE TYPE`/`CREATE SCHEMA` 撞
 *      `duplicate key ... pg_type_typname_nsp_index` / `schema already exists`；
 *   ② 串行：先跑的文件建了后续迁移表（如 distilled_artifacts），后跑的文件只 drop 了
 *      schema_migrations + 自己关心的少数表，残留表令 `ADD COLUMN compiled_via` 报 already-exists。
 * 根因都是「多文件共享 public schema」。本 helper 给每个测试文件一个**唯一命名的 schema**，
 * 经连接串 `search_path` 把该文件的所有迁移/读写都落进自己的 schema，并发文件之间互不可见，
 * 彻底消除竞态，且无需手维护表清单。
 *
 * 用法：
 *   const { db, cleanup } = await createIsolatedPgSchema('postgres');  // before
 *   ...                                                                // 用 db 跑迁移/测试
 *   await cleanup();                                                   // after：drop schema + 关连接
 */

/** 把 search_path 注入连接串：`search_path=<schema>,public`。
 * 新建对象（CREATE TABLE/TYPE）落 search_path 第一个 schema=专属 schema（隔离）；
 * 但**数据库级的 pgvector 扩展类型 `vector` 建在 public**，故 path 末尾保留 public 以解析该类型。
 * pg 支持连接串 `options=-c search_path=...`（空格交由 URL 编码）。 */
function withSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${schema},public`);
  return u.toString();
}

/** 唯一 schema 名：以文件 tag 区分（同进程内不同文件不撞）；只用 [a-z0-9_] 避免引号转义。 */
function schemaNameFor(fileTag: string): string {
  const safe = fileTag.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `test_${safe}`;
}

export interface IsolatedPgSchema {
  /** 落在专属 schema 上的数据库句柄（迁移/读写均经 search_path 进此 schema）。 */
  readonly db: import('../../../storage/postgres-database.js').PostgresDatabase;
  /** 释放：drop 专属 schema（CASCADE）并关闭连接池。 */
  readonly cleanup: () => Promise<void>;
}

/**
 * 为某测试文件创建独立 schema 并返回落在其上的 db。
 * @param fileTag 文件标识（如 'postgres' / 'quota' / 'embedding'），决定 schema 名。
 * @param testUrl TEST_POSTGRES_URL（调用方已确认非空）。
 */
export async function createIsolatedPgSchema(
  fileTag: string,
  testUrl: string,
  opts?: { max?: number; idleTimeoutMs?: number },
): Promise<IsolatedPgSchema> {
  const { PostgresDatabase } = await import('../../../storage/postgres-database.js');
  const { runDslPostgresMigrations } = await import('../../../storage/index.js');
  const schema = schemaNameFor(fileTag);

  /* 第一步：用基础连接（默认 public search_path）干净重建专属 schema，并先把数据库级的
   * pgvector 扩展建好。
   * - schema 的 DROP/CREATE 只动本文件自己的 schema，与并行文件互不相干，并发安全。
   * - 但 `CREATE EXTENSION IF NOT EXISTS vector` 是**数据库级**对象，多文件并行跑迁移时其
   *   非原子的 check-then-insert 会撞 `pg_extension_name_index` unique。故在此用**会话级咨询锁**
   *   （pg_advisory_lock，固定 key）串行化扩展创建，建完即解锁；迁移里那条 IF NOT EXISTS 随后变 no-op。 */
  const admin = new PostgresDatabase(testUrl, { max: 1, idleTimeoutMs: 5_000 });
  admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  admin.exec(`CREATE SCHEMA ${schema}`);
  /* 任意固定 key；同 key 的并发会话串行。建在 public（扩展全库可见，schema 无关）。 */
  admin.exec('SELECT pg_advisory_lock(727274)');
  try {
    admin.exec('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    admin.exec('SELECT pg_advisory_unlock(727274)');
  }
  admin.close();

  /* 第二步：用带 search_path 的连接跑迁移——所有 CREATE TABLE/TYPE/扩展都落进专属 schema。
   * 注：pgvector 扩展是数据库级对象，CREATE EXTENSION IF NOT EXISTS 幂等，多文件共享无碍。 */
  const db = new PostgresDatabase(withSearchPath(testUrl, schema), {
    max: opts?.max ?? 5,
    idleTimeoutMs: opts?.idleTimeoutMs ?? 10_000,
  });
  runDslPostgresMigrations(db);

  const cleanup = async (): Promise<void> => {
    db.close();
    /* 用独立基础连接 drop schema（此时 db 池已关，避免「正在使用」）。 */
    const dropper = new PostgresDatabase(testUrl, { max: 1, idleTimeoutMs: 5_000 });
    try {
      dropper.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      dropper.close();
    }
  };

  return { db, cleanup };
}
