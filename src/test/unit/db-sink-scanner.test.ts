/**
 * db-sink-scanner 类型判定内核单元测（Task 1）。
 *
 * 覆盖：
 *  - canonical SyncWriteUnitOfWork type 从 .d.ts 解析成功（否则 buildProgram 应 fail-closed）
 *  - 类型判定：canonical / alias / 结构兼容(纯 UoW) / union / generic 判 DB 能力；negative 不判
 *  - fail-closed：tsconfig 不存在 → 抛；Program 建出但 sentinel 缺 → 抛
 *
 * 用 tsx 运行（能直接跑 .mjs import + .ts fixture）：
 *   npx tsx --test src/test/unit/db-sink-scanner.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {
  buildProgram,
  isDbCapabilityType,
  enumerateDbCapabilityEdges,
  collectUnregisteredEdges,
} from '../../../scripts/db-sink-scanner.mjs';

/**
 * 从 type-alias.ts 取某个 export 声明的**目标类型**：
 *  - 类型别名（TypeAliasDeclaration）取其别名类型本身。
 *  - interface（InterfaceDeclaration）取其声明类型。
 *  - 函数：给 paramName 时取该**参数节点**的类型（getTypeAtLocation），
 *    而非函数整体的签名类型（Codex 第 3 轮 #4）。
 */
function makeProbe(program: ts.Program, checker: ts.TypeChecker) {
  const rel = 'db-sink-fixtures/type-alias.ts';
  const sf = program.getSourceFiles().find((f) => f.fileName.includes(rel));
  assert.ok(sf, `未找到 fixture ${rel}`);
  return (declName: string, paramName?: string): ts.Type | undefined => {
    let result: ts.Type | undefined;
    const visit = (node: ts.Node): void => {
      if (result) return;
      if (ts.isTypeAliasDeclaration(node) && node.name.text === declName) {
        result = checker.getTypeAtLocation(node.name);
        return;
      }
      if (ts.isInterfaceDeclaration(node) && node.name.text === declName) {
        result = checker.getTypeAtLocation(node.name);
        return;
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === declName) {
        if (paramName) {
          const param = node.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === paramName);
          assert.ok(param, `函数 ${declName} 未找到参数 ${paramName}`);
          result = checker.getTypeAtLocation(param);
        } else {
          result = checker.getTypeAtLocation(node.name);
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return result;
  };
}

/**
 * 单进程内共享一次 buildProgram（tsconfig.src.json = 整个 src 树，重建 + 全量枚举很贵，
 * ~1.5s build + ~35s enumerate）。所有只读断言复用同一 Program / edge 全集，避免 18 个
 * 测试各自重建导致的 >10 分钟运行时。fail-closed 抛测试用不同 tsconfig，不受影响。
 */
let _built: ReturnType<typeof buildProgram> | undefined;
function builtProgram(): ReturnType<typeof buildProgram> {
  if (!_built) _built = buildProgram('tsconfig.src.json');
  return _built;
}
let _fixtureEdges: import('../../../scripts/db-sink-scanner.d.mts').Edge[] | undefined;
function fixtureEdges(): import('../../../scripts/db-sink-scanner.d.mts').Edge[] {
  if (!_fixtureEdges) {
    const { program, checker, uowType } = builtProgram();
    _fixtureEdges = enumerateDbCapabilityEdges(program, checker, uowType, { includeTests: true }).filter((e) =>
      e.file.includes('db-sink-fixtures'),
    );
  }
  return _fixtureEdges;
}

test('canonical DB/UoW type 解析成功（否则 fail-closed）', () => {
  const { uowType } = builtProgram();
  assert.ok(uowType, 'canonical SyncWriteUnitOfWork 未解析——扫描器应 fail-closed 而非空扫');
});

test('类型判定：canonical/alias/结构兼容(纯UoW)/union/generic 都判 DB 能力；negative 不判', () => {
  const { program, checker, uowType } = builtProgram();
  const probeType = makeProbe(program, checker);
  assert.equal(isDbCapabilityType(probeType('DbAlias'), checker, uowType), true, '别名 DbAlias 应判 DB 能力');
  assert.equal(
    isDbCapabilityType(probeType('StructuralUow'), checker, uowType),
    true,
    '纯 UoW 4 方法 StructuralUow 应判 DB 能力（证上界=UoW 非 IDatabase）',
  );
  assert.equal(
    isDbCapabilityType(probeType('optionalDb', 'db'), checker, uowType),
    true,
    'IDatabase | undefined 应逐分量判 DB 能力',
  );
  assert.equal(
    isDbCapabilityType(probeType('genericDb', 'tx'), checker, uowType),
    true,
    'T extends SyncWriteUnitOfWork 应取 base constraint 判 DB 能力',
  );
  assert.equal(isDbCapabilityType(probeType('NotDb'), checker, uowType), false, 'negative control NotDb 不应判 DB 能力');
});

test('fail-closed：tsconfig 不存在 → buildProgram 抛（不返回空 uowType）', () => {
  assert.throws(() => buildProgram('tsconfig.does-not-exist.json'));
});

test('fail-closed：Program 建出但 sentinel 缺（只含无关文件的 tsconfig）→ 抛，不空扫报绿', () => {
  assert.throws(
    () => buildProgram('src/test/support/db-sink-fixtures/tsconfig.sentinel-missing.json'),
    /sentinel 缺失/,
  );
});

/* ============================================================================
 * Task 2：edge 级枚举 —— A1-A4 接收 + B1-B8 转移全形态 + edge 级 ID。
 *
 * 表驱动逐文件 deepEqual 完整期望集（Codex #3——非 some(kind)，防占位 target/param + 漏 edge）。
 * 每个 fixture 的期望 edge 全集（owner/kind/target/param）按 fixture 内容固定。
 * ==========================================================================*/

interface ExpectEdge {
  owner: string;
  kind: string;
  target: string;
  param: string;
}

const FIXTURE_EXPECT: Record<string, ExpectEdge[]> = {
  // A2 parameter property（specificity precedence：只归 ctor-param，不再另产 fn-param）。
  'ctor-param.ts': [{ owner: 'CtorParamFixture', kind: 'ctor-param', target: 'CtorParamFixture', param: 'db' }],
  // A4 PropertySignature（interface 的 db 属性）。
  'deps-prop.ts': [{ owner: 'FixtureDeps', kind: 'deps-prop', target: 'FixtureDeps', param: 'db' }],
  // A1 FunctionDeclaration 参数（未被闭包捕获 → 保留 route-param）。
  'route-param.ts': [{ owner: 'registerFixtureRoutes', kind: 'route-param', target: 'registerFixtureRoutes', param: 'db' }],
  // B7 capture（precedence：参数被嵌套闭包捕获 → 只报 capture，压制 acceptance）。
  'capture.ts': [{ owner: 'makeTimer', kind: 'capture', target: 'makeTimer', param: 'db' }],
  // B2 new argument（≥2 不同 target 证 edge 级不合并）。
  'factory-indirect.ts': [
    { owner: 'FactoryFixture', kind: 'factory-indirect', target: 'ServiceA', param: 'db' },
    { owner: 'FactoryFixture', kind: 'factory-indirect', target: 'ServiceB', param: 'db' },
  ],
  // 包裹型能力转移（整体类型不可赋 UoW，靠 findDbCapabilityPaths 递归识别）。
  'wrapped.ts': [
    { owner: 'wrapOptions', kind: 'factory-indirect', target: 'Service', param: 'options.db' }, // new Service(options)，options.db 是 UoW
    { owner: 'wrapReturn', kind: 'return', target: 'return', param: 'db' }, // return { db }
    { owner: 'wrapSpread', kind: 'aggregate-wrapping', target: 'object', param: '...deps' }, // { ...deps }（deps 含 db）
  ],
  // B8 module/export transfer（ExportAssignment + NamedExports）。
  'export-transfer.ts': [
    { owner: '<module>', kind: 'module-export', target: 'default', param: 'db' }, // export default db
    { owner: '<module>', kind: 'module-export', target: 'named', param: 'db2' }, // export { db2 }
  ],
  // A4 双能力属性（active-stack visited canary：两条 path 都要出，全局 visited 会漏第二条）。
  'pair.ts': [
    { owner: 'Pair', kind: 'deps-prop', target: 'Pair', param: 'primary' },
    { owner: 'Pair', kind: 'deps-prop', target: 'Pair', param: 'replica' },
  ],
  // 无 initializer 的 sink declaration（A2 ctor 参数属性 + A3 无初始化字段）。
  'sink-decl.ts': [
    { owner: 'SinkService', kind: 'ctor-param', target: 'SinkService', param: 'db' }, // constructor(private readonly db)
    { owner: 'SinkStore', kind: 'field-decl', target: 'SinkStore', param: 'db' }, // private db!: IDatabase（无 initializer）
  ],
  // A1 FunctionExpression + setter（验 ts.isFunctionLike 真覆盖，防手列漏 FunctionExpression）。
  'function-like.ts': [
    { owner: 'fnExpr', kind: 'fn-param', target: 'fnExpr', param: 'db' }, // const fnExpr = function(db){}
    { owner: 'DbHolder.database', kind: 'fn-param', target: 'set database', param: 'db' }, // set database(db)
  ],
};

/** 稳定排序键：owner/kind/target/param 的 JSON 串。 */
const sortKey = (e: ExpectEdge): string => JSON.stringify(e);

for (const [file, expected] of Object.entries(FIXTURE_EXPECT)) {
  test(`fixture ${file}：产出的 edge 全集精确匹配（deepEqual，非 some）`, () => {
    const got = fixtureEdges()
      .filter((e) => e.file.includes(`db-sink-fixtures/${file}`))
      .map((e) => ({ owner: e.owner, kind: e.kind, target: e.target, param: e.param }))
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    assert.deepEqual(got, [...expected].sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
  });
}

test('edge 级不合并回归：factory-indirect 两 target 是 2 条不同 edge（禁 owner 合并）', () => {
  const edges = fixtureEdges().filter((e) => e.file.includes('db-sink-fixtures/factory-indirect.ts'));
  const ids = new Set(edges.map((e) => e.id));
  assert.equal(ids.size, 2, 'factory-indirect 同 owner 两 target 必须是 2 条独立 edge，不得按 owner 合并');
  assert.ok(edges.some((e) => e.target === 'ServiceA'));
  assert.ok(edges.some((e) => e.target === 'ServiceB'));
});

test('active-stack 双 path：pair.ts 两条 deps-prop edge 都产出（全局 visited 会漏第二条）', () => {
  const params = new Set(
    fixtureEdges()
      .filter((e) => e.file.includes('db-sink-fixtures/pair.ts'))
      .map((e) => e.param),
  );
  assert.deepEqual([...params].sort(), ['primary', 'replica']);
});

test('单-ID-删除 mutation：从完整集合删一个指定 id → unregistered 恰为该 edge，其余仍登记', () => {
  const edges = fixtureEdges();
  const allIds = new Set(edges.map((e) => e.id));
  const victimEdge = edges.find((e) => e.file.includes('deps-prop'));
  assert.ok(victimEdge, 'deps-prop fixture 应至少有一条 edge 供删除');
  const victim = victimEdge.id;
  allIds.delete(victim); // 只删一个
  const unreg = collectUnregisteredEdges(edges, allIds);
  assert.deepEqual(
    unreg.map((e) => e.id),
    [victim],
    '恰好只有被删那条未登记',
  );
});

test('fixture 全集无 unknown-boundary edge（所有形态都可归 kind，否则门红）', () => {
  const unknown = fixtureEdges().filter((e) => e.kind === 'unknown-boundary');
  assert.deepEqual(unknown, [], `fixture 不应有 unknown-boundary：${JSON.stringify(unknown)}`);
});
