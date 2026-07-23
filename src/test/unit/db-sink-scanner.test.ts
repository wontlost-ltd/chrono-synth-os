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
  classifyPropagation,
  evaluateGate,
  readInventory,
} from '../../../scripts/db-sink-scanner.mjs';
type InventoryContract = import('../../../scripts/db-sink-scanner.d.mts').InventoryContract;

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
type Edge = import('../../../scripts/db-sink-scanner.d.mts').Edge;

/** includeTests:true 的全量 edge（含 fixture + src/test）——只枚举一次，供 fixture / classify 复用。 */
let _allEdges: Edge[] | undefined;
function allEdges(): Edge[] {
  if (!_allEdges) {
    const { program, checker, uowType } = builtProgram();
    _allEdges = enumerateDbCapabilityEdges(program, checker, uowType, { includeTests: true });
  }
  return _allEdges;
}
function fixtureEdges(): Edge[] {
  return allEdges().filter((e) => e.file.includes('db-sink-fixtures'));
}

/**
 * production scope（includeTests:false）的全量 edge——从 allEdges 过滤掉 src/test/** 复用，
 * 避免第二次 ~17s 枚举。语义与 scanProductionDbCapabilityEdges 一致（同一 Program，仅 scope 过滤）。
 */
function productionEdges(): Edge[] {
  return allEdges().filter((e) => !e.file.startsWith('src/test/'));
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

/* ============================================================================
 * Task 2.5：修扫描器过度触发（收窄数据属性递归，消 unknown 误报）+ edge 归因分类。
 *
 * 背景：Task 2 对 production 产 7701 edge，含 1269 unknown-boundary 误报——findDbCapabilityPaths
 * 递归**方法/原型面/库类型**（string.length / Buffer.subarray / zod 内部）→ 对 AppConfig/app
 * 等大类型预算爆。收窄后只递归**数据属性**，unknown 应清零。
 * ==========================================================================*/

test('①收窄后 production unknown-boundary 清零（否则门红——不为清零放宽，残留如实保留）', () => {
  const unknown = productionEdges().filter((e) => e.kind === 'unknown-boundary');
  assert.deepEqual(
    unknown.map((e) => `${e.file} | ${e.owner} | ${e.context ?? ''}`),
    [],
    `收窄数据属性递归后 production 不应再有 unknown-boundary 误报（残留即门红）`,
  );
});

test('②方法面 fixture（return rows / 返回含方法的 service 对象 / 标量+标准库容器）不产任何伪 edge', () => {
  const ms = allEdges().filter((e) => e.file.includes('db-sink-fixtures/method-surface.ts'));
  assert.deepEqual(
    ms.map((e) => ({ owner: e.owner, kind: e.kind, target: e.target, param: e.param })),
    [],
    `方法面/原型面/标准库容器不承载 per-tenant 数据存储，收窄后不应产 edge（含 unknown）：${JSON.stringify(ms)}`,
  );
});

test('③classifyPropagation：new ClassifyService(db) → linked-to-sink 且 sinkId 指向 ClassifyService ctor', () => {
  const { checker } = builtProgram();
  const linked = allEdges().find(
    (e) => e.file.includes('db-sink-fixtures/classify.ts') && e.owner === 'makeService' && e.target === 'ClassifyService',
  );
  assert.ok(linked, 'classify.ts 应有 new ClassifyService(db) 的 factory-indirect edge');
  const result = classifyPropagation(linked, checker, allEdges());
  assert.equal(result.propagation, 'linked-to-sink', 'new ClassifyService(db) 应归 linked-to-sink');
  assert.ok(
    typeof result.sinkId === 'string' && result.sinkId.includes('ClassifyService') && result.sinkId.includes('ctor-param'),
    `sinkId 应指向 ClassifyService 的 ctor-param A 点，实际=${result.sinkId}`,
  );
});

test('③classifyPropagation：export default escapingDb → terminal-escape（离开模块边界）', () => {
  const { checker } = builtProgram();
  const exported = allEdges().find(
    (e) => e.file.includes('db-sink-fixtures/classify.ts') && e.kind === 'module-export',
  );
  assert.ok(exported, 'classify.ts 应有 export default 的 module-export edge');
  const result = classifyPropagation(exported, checker, allEdges());
  assert.equal(result.propagation, 'terminal-escape', 'module-export 应归 terminal-escape（跨模块生命周期）');
});

test('③classifyPropagation：ephemeralUse 里 db 同步转给本地纯函数 useOnce → ephemeral（不逃逸）', () => {
  const { checker } = builtProgram();
  const eph = allEdges().find(
    (e) => e.file.includes('db-sink-fixtures/classify.ts') && e.owner === 'ephemeralUse' && e.target === 'useOnce',
  );
  assert.ok(eph, 'classify.ts 应有 ephemeralUse → useOnce 的同步转移 edge');
  const result = classifyPropagation(eph, checker, allEdges());
  assert.equal(result.propagation, 'ephemeral', 'db 只同步传给本地 per-request 纯函数、不逃逸 → ephemeral');
});

/* ============================================================================
 * Task 2.6：capability-carrier 压缩 + resolved provenance（Codex 第 8 轮裁决）。
 *
 * 背景：Task 2.5 后仍 11067 production edge，其中 81% 是 OS-facade 传递展开
 * （`os.core.memories.tx`…）——findDbCapabilityPaths 对类型为 ChronoSynthOS / CoreRhythmLayer /
 * store 类的参数递归展开内部每个 .tx。Codex 裁决：压成一条 carrier sink（内部 paths 存
 * capabilityPaths 元数据），但**不能按类型名当安全 opaque 放行**——carrier 可被 new 直接构造/
 * store 可被单独拎出传宿主 db，安全性靠 provenance 追来源（factory.getTenantOS/os.getCore=安全，
 * new 直构/deps/未知=unresolved 门红）。
 * ==========================================================================*/

/** 存储型 carrier sink 的 kind（一条 carrier 对，内部 .tx paths 进 edge.capabilityPaths）。 */
const CARRIER_KINDS = new Set(['carrier-param', 'carrier-field', 'carrier-arg']);

test('①carrier 压缩：production carrier sink edge 数 << 8976（facade .tx 展开压成 carrier sink）', () => {
  const prod = productionEdges();
  // 深 path（>=2 段点，如 os.core.memories.tx）是 facade 展开的指纹——压缩后应基本消失。
  const deepFacade = prod.filter((e) => (e.param.match(/\./g) ?? []).length >= 2);
  assert.ok(
    deepFacade.length < 200,
    `facade .tx deep 展开应被压成 carrier sink（残留 deep-path=${deepFacade.length}，样本：${JSON.stringify(
      deepFacade.slice(0, 8).map((e) => `${e.owner}::${e.kind}::${e.param}`),
    )}）`,
  );
  // 压缩后总 edge 数应从 11067 大降到低千级（真 sink ~955 + carrier sinks）。
  assert.ok(
    prod.length < 4000,
    `carrier 压缩后 production 总 edge 数应大降到低千级（实际=${prod.length}，基线 11067）`,
  );
  // carrier sink 确实产出（facade/store 参数/字段压成 carrier-param/carrier-field）。
  const carriers = prod.filter((e) => CARRIER_KINDS.has(e.kind));
  assert.ok(carriers.length > 0, 'production 应产出 carrier-param/carrier-field sink（facade 压缩产物）');
  // carrier sink 带 capabilityPaths 证据元数据（内部 .tx paths），不逐 path 产 edge。
  const withEvidence = carriers.filter((e) => Array.isArray(e.capabilityPaths) && e.capabilityPaths.length > 0);
  assert.ok(
    withEvidence.length > 0,
    'carrier sink 应带 capabilityPaths 证据元数据（内部 .tx paths 存于此而非逐条产 edge）',
  );
});

test('①chat.ts 的 os:ChronoSynthOS 参数压成一条 carrier-param（不再逐 .core.X.tx 炸 171+ edge）', () => {
  const chat = productionEdges().filter((e) => e.file.includes('companion/chat.ts'));
  // 压缩前 chat.ts 有 580 edge（含 171 fn-param + 58 route-param 的 os.core.X.tx 展开）。
  // 压缩后 os 参数只产 carrier sink，deep-path .tx 展开消失。
  const deepChat = chat.filter((e) => /\.core\.|\.memories\.|\.values\.|\.narrative\./.test(e.param));
  assert.deepEqual(
    deepChat.map((e) => `${e.owner}::${e.kind}::${e.param}`),
    [],
    'chat.ts 的 os facade .core.X.tx 展开应被压成 carrier sink（残留即压缩未生效）',
  );
});

test('②carrier-safe fixture：factory.getTenantOS(tid) 传下游 → linked-to-resolved-carrier', () => {
  const { checker } = builtProgram();
  const edges = allEdges();
  // os 来自 getTenantOS → useOs(os) 的 carrier 传播 edge。
  const safeOs = edges.find(
    (e) => e.file.includes('db-sink-fixtures/carrier-safe.ts') && e.owner === 'safeOsFromFactory' && e.target === 'useOs',
  );
  assert.ok(safeOs, 'carrier-safe.ts 应有 safeOsFromFactory → useOs(os) 的 carrier 传播 edge');
  const r1 = classifyPropagation(safeOs, checker, edges);
  assert.equal(
    r1.propagation,
    'linked-to-resolved-carrier',
    `os 来自 getTenantOS（resolver 入口）→ 应归 linked-to-resolved-carrier，实际=${r1.propagation}（${r1.reason ?? ''}）`,
  );
  // core 来自 os.getCore（os 又来自 getTenantOS）→ useCore(core) 也应 resolved。
  const safeCore = edges.find(
    (e) => e.file.includes('db-sink-fixtures/carrier-safe.ts') && e.owner === 'safeCoreFromGetCore' && e.target === 'useCore',
  );
  assert.ok(safeCore, 'carrier-safe.ts 应有 safeCoreFromGetCore → useCore(core) 的 carrier 传播 edge');
  const r2 = classifyPropagation(safeCore, checker, edges);
  assert.equal(
    r2.propagation,
    'linked-to-resolved-carrier',
    `core 来自 os.getCore（persona resolver）→ 应归 linked-to-resolved-carrier，实际=${r2.propagation}（${r2.reason ?? ''}）`,
  );
});

test('③carrier-unsafe fixture：new ChronoSynthOS() 直构传下游 → unresolved-carrier（门红，非按类型放行）', () => {
  const { checker } = builtProgram();
  const edges = allEdges();
  const unsafeOs = edges.find(
    (e) => e.file.includes('db-sink-fixtures/carrier-unsafe.ts') && e.owner === 'unsafeOsFromNew' && e.target === 'useOs',
  );
  assert.ok(unsafeOs, 'carrier-unsafe.ts 应有 unsafeOsFromNew → useOs(os) 的 carrier 传播 edge');
  const r = classifyPropagation(unsafeOs, checker, edges);
  assert.equal(
    r.propagation,
    'unresolved-carrier',
    `os 由 new ChronoSynthOS 直构（未经 resolver）→ 应归 unresolved-carrier（门红），实际=${r.propagation}（${r.reason ?? ''}）`,
  );
});

test('④内部 store ctor 直接 sink 仍在 edge 集（CognitiveMemoryGraph.ctor::tx 未被 carrier 压缩吞）', () => {
  const edges = allEdges();
  // CognitiveMemoryGraph 自身的 ctor 参数 tx: SyncWriteUnitOfWork 是直接 UoW（path=[]）——
  // 是内部 store 直接 sink，绝不能因 carrier 压缩被隐藏。owner=CognitiveMemoryGraph，param 含 tx。
  const storeSink = edges.filter(
    (e) => e.owner === 'CognitiveMemoryGraph' && e.param === 'tx' && !CARRIER_KINDS.has(e.kind),
  );
  assert.ok(
    storeSink.length > 0,
    `CognitiveMemoryGraph 的 ctor 参数 tx 直接 sink 必须保留（内部 store 直接 sink），实际=${JSON.stringify(
      edges.filter((e) => e.owner === 'CognitiveMemoryGraph').map((e) => `${e.kind}::${e.param}`),
    )}`,
  );
  // 且 new CognitiveMemoryGraph(hostDb()) 的实参是直接 UoW sink（非 carrier 压缩）——db 来源 hostDb（未解析）。
  const directStoreArg = edges.find(
    (e) =>
      e.file.includes('db-sink-fixtures/carrier-unsafe.ts') &&
      e.target === 'CognitiveMemoryGraph' &&
      !CARRIER_KINDS.has(e.kind),
  );
  assert.ok(
    directStoreArg,
    'new CognitiveMemoryGraph(hostDb()) 的 hostDb 实参是直接 UoW sink（不被 carrier 压缩吞）',
  );
});

/* ============================================================================
 * Plan 0 终审 Important 修复：provenance 符号级校验（消唯一乐观归因点）。
 *
 * traceCarrierProvenance 原按**方法名字符串**判 resolver 入口（getTenantOS/getCore），未校验
 * callee 真实符号是否解析到 TenantOSFactory.getTenantOS / ChronoSynthOS.getCore。收紧成
 * **(声明文件, enclosing 类型, 方法名) 三元组符号级校验**后：
 *  ⑤ 同名本地函数（carrier-local-shadow.ts 的本地 getTenantOS，default 分支 return root os）
 *     的下游 carrier-arg 判 unresolved-carrier（非 resolved）——符号解析到本文件 FunctionDeclaration。
 *  ⑥ 真 factory.getTenantOS / os.getCore（carrier-safe.ts）仍判 linked-to-resolved-carrier
 *     （符号真解析到 TenantOSFactory / ChronoSynthOS）——收紧不误伤真 resolver。
 *  ⑦ production：avatars.ts 本地 getTenantOS 下游（handleProjection → compilePersonaState(core)）
 *     从 resolved 收紧为 unresolved-carrier（真实生产证据）。
 * ==========================================================================*/

test('⑤符号级：同名本地 getTenantOS（default return root os）下游 → unresolved-carrier（非按名字放行）', () => {
  const { checker } = builtProgram();
  const edges = allEdges();
  const shadow = edges.find(
    (e) =>
      e.file.includes('db-sink-fixtures/carrier-local-shadow.ts') &&
      e.owner === 'shadowedLocalGetTenantOS' &&
      e.target === 'useCore',
  );
  assert.ok(shadow, 'carrier-local-shadow.ts 应有 shadowedLocalGetTenantOS → useCore(core) 的 carrier 传播 edge');
  const r = classifyPropagation(shadow, checker, edges);
  assert.equal(
    r.propagation,
    'unresolved-carrier',
    `core 来自**本地同名** getTenantOS（非 TenantOSFactory.getTenantOS，default 返回 root os）→ ` +
      `符号级校验应判 unresolved-carrier（门红），实际=${r.propagation}（${r.reason ?? ''}）`,
  );
});

test('⑥符号级：真 factory.getTenantOS / os.getCore（carrier-safe）仍判 linked-to-resolved-carrier（不误伤）', () => {
  const { checker } = builtProgram();
  const edges = allEdges();
  const safeOs = edges.find(
    (e) => e.file.includes('db-sink-fixtures/carrier-safe.ts') && e.owner === 'safeOsFromFactory' && e.target === 'useOs',
  );
  assert.ok(safeOs, 'carrier-safe.ts 应有 safeOsFromFactory → useOs(os)');
  assert.equal(
    classifyPropagation(safeOs, checker, edges).propagation,
    'linked-to-resolved-carrier',
    '真 TenantOSFactory.getTenantOS 符号解析命中 → 仍 resolved（符号级不误伤真 resolver）',
  );
  const safeCore = edges.find(
    (e) =>
      e.file.includes('db-sink-fixtures/carrier-safe.ts') && e.owner === 'safeCoreFromGetCore' && e.target === 'useCore',
  );
  assert.ok(safeCore, 'carrier-safe.ts 应有 safeCoreFromGetCore → useCore(core)');
  assert.equal(
    classifyPropagation(safeCore, checker, edges).propagation,
    'linked-to-resolved-carrier',
    '真 ChronoSynthOS.getCore 符号解析命中 → 仍 resolved',
  );
});

test('⑦production 证据：avatars.ts 本地 getTenantOS 下游 compilePersonaState(core) 收紧为 unresolved-carrier', () => {
  const edges = productionEdges();
  const avatarCoreArgs = edges.filter(
    (e) =>
      e.file.includes('server/routes/avatars.ts') &&
      e.kind === 'carrier-arg' &&
      e.target === 'compilePersonaState' &&
      e.param === 'core',
  );
  assert.ok(
    avatarCoreArgs.length > 0,
    'avatars.ts 应有 compilePersonaState(tenantOS.core) 的 carrier-arg edge（本地 getTenantOS 下游）',
  );
  for (const e of avatarCoreArgs) {
    assert.equal(
      e.carrierProvenance?.resolved,
      false,
      `avatars.ts 本地 getTenantOS 下游 core 来源须收紧为 unresolved（provenance.resolved=false），` +
        `实际 provenance=${JSON.stringify(e.carrierProvenance)}`,
    );
  }
});

/* ============================================================================
 * Task 3/4：semantic-flow contract 门（evaluateGate，planned 级）+ 变异自证。
 *
 * evaluateGate(productionEdges, inventory, {requiredLevel:'planned'}) 断言五条空集：
 *   unknownEdges / unregisteredSemanticSinks / uncoveredPropagationEdges /
 *   unreviewedUnresolvedCarriers / invalidInventoryGroups。
 * Plan 0 只跑 planned 级；pass iff 五条全空。变异自证证明门真收紧（非空过）。
 * ==========================================================================*/

/** 当前 inventory（AST 解析）——所有门测试共享。 */
let _inv: InventoryContract[] | undefined;
function inventory(): InventoryContract[] {
  if (!_inv) _inv = readInventory();
  return _inv;
}

test('evaluateGate(planned)：当前 inventory 下五条诊断全空 → pass（Plan 0 门通过）', () => {
  const r = evaluateGate(productionEdges(), inventory(), { requiredLevel: 'planned' });
  assert.equal(r.unknownEdges.length, 0, `unknownEdges 非空：${JSON.stringify(r.unknownEdges.slice(0, 5))}`);
  assert.equal(
    r.unregisteredSemanticSinks.length,
    0,
    `unregisteredSemanticSinks 非空：${JSON.stringify(r.unregisteredSemanticSinks.slice(0, 5))}`,
  );
  assert.equal(
    r.uncoveredPropagationEdges.length,
    0,
    `uncoveredPropagationEdges 非空：${JSON.stringify(r.uncoveredPropagationEdges.slice(0, 5))}`,
  );
  assert.equal(
    r.unreviewedUnresolvedCarriers.length,
    0,
    `unreviewedUnresolvedCarriers 非空：${JSON.stringify(r.unreviewedUnresolvedCarriers.slice(0, 5))}`,
  );
  assert.equal(
    r.invalidInventoryGroups.length,
    0,
    `invalidInventoryGroups 非空：${JSON.stringify(r.invalidInventoryGroups.slice(0, 5))}`,
  );
  assert.equal(r.pass, true, 'planned 门应通过');
});

test('门诊断结构：各类非空时含具体 id/file/kind（缺 inventory → 大量 unregistered/uncovered/unreviewed）', () => {
  // 传空 inventory → 门应报出全部 storing sink + escape 未登记、传播未覆盖、unresolved 未审阅。
  const r = evaluateGate(productionEdges(), [], { requiredLevel: 'planned' });
  assert.equal(r.pass, false, '空 inventory 门必红');
  assert.ok(r.unregisteredSemanticSinks.length > 0, '空 inventory 应报大量 unregisteredSemanticSinks');
  assert.ok(r.unreviewedUnresolvedCarriers.length > 0, '空 inventory 应报大量 unreviewedUnresolvedCarriers');
  // 诊断项含具体定位信息。
  const s = r.unregisteredSemanticSinks[0];
  assert.ok(s.id && s.file && s.kind, 'unregisteredSemanticSinks 项应含 id/file/kind');
});

test('变异自证①：从某 flow contract 删一个 coveredEdgeId → 该 edge uncovered/count 不匹配 → 门红', () => {
  const inv = inventory();
  // 找一个覆盖 ≥2 edge 的 flow contract（删一个后仍是合法数组）。
  const victim = inv.find((c) => Array.isArray(c.coveredEdgeIds) && c.coveredEdgeIds.length >= 2);
  assert.ok(victim, 'inventory 应有覆盖 ≥2 edge 的 flow contract 供变异');
  const removed = victim!.coveredEdgeIds![0];
  // 深拷贝 + 删一个 id（expectedCount 不变，制造 fingerprint 不匹配 + 该 edge uncovered）。
  const mutated: InventoryContract[] = inv.map((c) =>
    c === victim
      ? { ...c, coveredEdgeIds: c.coveredEdgeIds!.filter((id) => id !== removed) }
      : { ...c, coveredEdgeIds: c.coveredEdgeIds ? [...c.coveredEdgeIds] : undefined },
  );
  const r = evaluateGate(productionEdges(), mutated, { requiredLevel: 'planned' });
  assert.equal(r.pass, false, '删一个 coveredEdgeId 后门必须红（证精确覆盖非通配）');
  // 该 id 变 uncovered：出现在 unregistered 或 uncovered 或 unreviewed 之一；且 count 不匹配触发 invalidInventoryGroups。
  const flaggedElsewhere =
    r.unregisteredSemanticSinks.some((x) => x.id === removed) ||
    r.uncoveredPropagationEdges.some((x) => x.id === removed) ||
    r.unreviewedUnresolvedCarriers.some((x) => x.id === removed);
  const countMismatch = r.invalidInventoryGroups.some((g) => g.id === victim!.id);
  assert.ok(
    flaggedElsewhere || countMismatch,
    `删掉的 edge ${removed} 应因 uncovered 或 count 不匹配被门捕获（unregistered/uncovered/unreviewed=${flaggedElsewhere}, invalidGroup=${countMismatch}）`,
  );
});

test('变异自证②：把某 unresolved-carrier 覆盖组 reviewStatus 改回 unreviewed → unreviewedUnresolvedCarriers 非空 → 门红', () => {
  const edges = productionEdges();
  const inv = inventory();
  // 找一个覆盖 ≥1 条 unresolved-carrier edge 的 flow contract。
  const propOf = new Map(edges.map((e) => [e.id, classifyPropagation(e, null, edges).propagation]));
  const victim = inv.find(
    (c) => Array.isArray(c.coveredEdgeIds) && c.coveredEdgeIds.some((id) => propOf.get(id) === 'unresolved-carrier'),
  );
  assert.ok(victim, 'inventory 应有覆盖 unresolved-carrier 的 flow contract 供变异');
  // 深拷贝 + 把该组 reviewStatus 改回 unreviewed（模拟退化）。
  const mutated: InventoryContract[] = inv.map((c) =>
    c === victim
      ? { ...c, reviewStatus: 'unreviewed' as const, coveredEdgeIds: [...c.coveredEdgeIds!] }
      : { ...c, coveredEdgeIds: c.coveredEdgeIds ? [...c.coveredEdgeIds] : undefined },
  );
  const r = evaluateGate(edges, mutated, { requiredLevel: 'planned' });
  assert.equal(r.pass, false, 'reviewStatus 退化为 unreviewed 后门必须红（禁「scanner 不知→planned→绿」）');
  assert.ok(
    r.unreviewedUnresolvedCarriers.length > 0,
    'reviewStatus=unreviewed 的 unresolved-carrier 覆盖组应进 unreviewedUnresolvedCarriers',
  );
});

test('变异自证③：把某 flow contract coveredEdgeId 改成 owner::* 通配 → invalidInventoryGroups 非空 → 门红', () => {
  const inv = inventory();
  const victim = inv.find((c) => Array.isArray(c.coveredEdgeIds) && c.coveredEdgeIds.length >= 1);
  assert.ok(victim, 'inventory 应有 flow contract 供变异');
  const mutated: InventoryContract[] = inv.map((c) =>
    c === victim
      ? { ...c, coveredEdgeIds: [`${c.file}#${'owner'}::*`, ...c.coveredEdgeIds!.slice(1)] }
      : { ...c, coveredEdgeIds: c.coveredEdgeIds ? [...c.coveredEdgeIds] : undefined },
  );
  const r = evaluateGate(productionEdges(), mutated, { requiredLevel: 'planned' });
  assert.equal(r.pass, false, '引入 owner::* 通配后门必须红（禁通配白名单）');
  assert.ok(
    r.invalidInventoryGroups.some((g) => g.id === victim!.id && g.problems.some((p) => p.includes('通配'))),
    '通配 id 应被 invalidInventoryGroups 捕获',
  );
});

test('readInventory：AST 解析出 flow contract（含 coveredEdgeIds + expectedCount）+ legacy 条目', () => {
  const inv = inventory();
  assert.ok(inv.length > 100, `readInventory 应解析出全部条目（实际=${inv.length}）`);
  const flows = inv.filter((c) => Array.isArray(c.coveredEdgeIds));
  assert.ok(flows.length > 50, `应解析出大量 flow contract（实际=${flows.length}）`);
  // expectedCount 与 coveredEdgeIds 数一致（AST 解析正确）。
  for (const c of flows.slice(0, 20)) {
    assert.equal(c.expectedCount, c.coveredEdgeIds!.length, `${c.id} expectedCount 解析不一致`);
  }
});
