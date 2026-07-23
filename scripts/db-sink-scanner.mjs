/**
 * DB-capability edge 扫描器 —— 类型驱动（TS Program + TypeChecker）内核。
 *
 * 本文件（Task 1）实现三件事，全部以 **fail-closed** 为最高原则：
 *   1. buildProgram(tsconfigPath) —— 建 Program + 健康门（config/options/global/syntactic
 *      致命 diagnostic、root files 为空、sentinel 生产入口缺失 → 抛）。
 *   2. resolveCanonicalUowType —— 从 src/storage/database.ts 的 IDatabase interface 的
 *      heritage clause（extends SyncWriteUnitOfWork）解析出 canonical 检测上界的 type。
 *      **上界固定为 SyncWriteUnitOfWork（非 IDatabase）**：IDatabase 额外要求
 *      dialect/exec/prepare/transactionRollback/close，更严，用它作上界会漏掉只持
 *      SyncWriteUnitOfWork 的长期 service / closure（如 fromUnitOfWork(tx) 传的 tx）。
 *   3. isDbCapabilityType —— 逐 union / intersection 分量 + generic 约束 + 结构兼容
 *      判定某类型是否携带 DB 能力。绝不 try/catch → return false（吞异常 = 静默漏扫）。
 *
 * 核心不变量：扫描器宁可 fail-closed（canonical 解析失败 / Program 不健康 → 退出非零），
 * 也绝不「漏扫却报绿」。
 */
import ts from 'typescript';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 生产入口哨兵：这些文件必须出现在 Program 的 sourceFiles 中，否则 Program 范围不对。 */
const SENTINELS = [
  'src/main.ts',
  'src/main-desktop.ts',
  'src/main-observability-worker.ts',
  'src/server/app.ts',
];

/**
 * 建 TS Program + 健康门 + 解析 canonical UoW type。
 * @param {string} [tsconfigPath] 相对仓库根的 tsconfig 路径（默认 tsconfig.src.json）。
 * @returns {{ program: import('typescript').Program, checker: import('typescript').TypeChecker, uowType: import('typescript').Type, parsed: import('typescript').ParsedCommandLine }}
 */
export function buildProgram(tsconfigPath = 'tsconfig.src.json') {
  const configPath = join(ROOT, tsconfigPath);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`tsconfig 解析失败: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    },
  });
  if (!parsed || parsed.fileNames.length === 0) {
    throw new Error(`Program root files 为空（${tsconfigPath}）——fail-closed`);
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  /* Program 健康门（fail-closed）：config/options/global/syntactic 致命 diagnostic → 抛。
   * 语法错 = 源码没被正确解析 → 类型不可信 → 静默空扫会报假绿。
   * 注：不校验全库 semantic diagnostics（跨包类型噪音多，且 skipLibCheck 下不影响
   * 本门要用的 canonical 解析）——只 config/options/global/syntactic 致命项 + canonical + sentinel。 */
  const fatal = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
  ].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    throw new Error(
      `Program 致命 diagnostic ${fatal.length} 条——fail-closed: ${ts.flattenDiagnosticMessageText(fatal[0].messageText, '\n')}`,
    );
  }

  const checker = program.getTypeChecker();

  /* sentinel 生产入口必须在 Program（tsconfig 路径错 → sentinel 缺 → fail-closed）。 */
  const files = new Set(program.getSourceFiles().map((sf) => relative(ROOT, sf.fileName)));
  for (const s of SENTINELS) {
    if (!files.has(s)) {
      throw new Error(`sentinel 缺失 ${s}——Program 范围不对，fail-closed`);
    }
  }

  /* canonical UoW type：从 database.ts 的 IDatabase 解析（extends SyncWriteUnitOfWork）。
   * 解析不到 → 抛（绝不返回空 uowType 空扫报绿）。 */
  const uowType = resolveCanonicalUowType(program, checker);
  if (!uowType) {
    throw new Error('canonical SyncWriteUnitOfWork 未解析——fail-closed（绝不空扫报绿）');
  }

  return { program, checker, uowType, parsed };
}

/**
 * 解析 canonical SyncWriteUnitOfWork 的 type（capability 检测上界）。
 *
 * 从 src/storage/database.ts 的 `interface IDatabase extends SyncWriteUnitOfWork` 的
 * heritage clause 取基类型的 symbol：
 *   getSymbolAtLocation(expression) → 得到 import 别名 symbol
 *   → getAliasedSymbol 解 alias → 得到 SyncWriteUnitOfWork 本体 symbol（.d.ts）
 *   → getDeclaredTypeOfSymbol 取其声明类型。
 *
 * @returns {import('typescript').Type | undefined} 未解析 → undefined（由 buildProgram fail-closed）。
 */
function resolveCanonicalUowType(program, checker) {
  const dbFile = program
    .getSourceFiles()
    .find((sf) => relative(ROOT, sf.fileName) === 'src/storage/database.ts');
  if (!dbFile) return undefined;

  let uowType;
  ts.forEachChild(dbFile, (node) => {
    if (uowType) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'IDatabase' && node.heritageClauses) {
      for (const h of node.heritageClauses) {
        for (const t of h.types) {
          const sym = checker.getSymbolAtLocation(t.expression);
          const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
          if (target && target.name === 'SyncWriteUnitOfWork') {
            uowType = checker.getDeclaredTypeOfSymbol(target);
          }
        }
      }
    }
  });
  return uowType;
}

/**
 * 判定某类型是否携带 DB 能力（可赋给 canonical SyncWriteUnitOfWork）。
 *
 * 处理形态：
 *   - union：逐分量（IDatabase | undefined 不直接过，取分量判）。
 *   - intersection：逐分量。
 *   - generic：T extends SyncWriteUnitOfWork → 取 getBaseConstraintOfType 判约束。
 *   - 结构兼容：checker.isTypeAssignableTo(type, uowType) —— undefined/null/primitive 不能赋 → false。
 *
 * ⚠️ 绝不 try/catch → return false：吞异常 = 静默漏扫假绿。checker 抛异常时向上冒泡
 * （调用点须带 node/file context 重抛），扫描器退出非零（fail-closed）。
 *
 * @param {import('typescript').Type | undefined} type
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} uowType canonical SyncWriteUnitOfWork type
 * @returns {boolean}
 */
export function isDbCapabilityType(type, checker, uowType) {
  if (!type) return false;

  /* 退化类型排除（否则假阳性淹没门）：
   *  - never 是 bottom type，可赋给任意类型（含 UoW）→ 必须排除，否则 `[] as never[]`、
   *    `throw` 分支等到处误判 DB 能力。
   *  - any/unknown 是 top type，isTypeAssignableTo 双向为真 → 排除，避免把每个 any 值当 DB。
   *  - void/null/undefined 显然非 DB 能力。
   * 这是 capability 精确判定的一部分（类型驱动），不是「吞异常」——语义上这些类型确实不携带 DB 能力。 */
  const flags = type.flags;
  if (
    flags & (ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Void | ts.TypeFlags.Null | ts.TypeFlags.Undefined)
  ) {
    return false;
  }

  if (type.isUnion?.()) {
    return type.types.some((t) => isDbCapabilityType(t, checker, uowType));
  }
  if (type.isIntersection?.()) {
    return type.types.some((t) => isDbCapabilityType(t, checker, uowType));
  }

  // generic 约束：T extends SyncWriteUnitOfWork → 取 constraint 判定。
  if (type.isTypeParameter?.()) {
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint && isDbCapabilityType(constraint, checker, uowType)) return true;
  }

  // 结构兼容：能赋给 uowType（SyncWriteUnitOfWork）即 DB 能力。
  if (checker.isTypeAssignableTo(type, uowType)) return true;

  /* isTypeAssignableTo 对某些纯结构类型可能因方法参数逆变/泛型细节判 false；
   * 退化为「uowType 的每个 property 都在 candidate 上存在」的成员覆盖判定——
   * 核心不变量：只持 UoW 4 方法（queryOne/queryMany/execute/transaction）的类型必须判 DB 能力。 */
  const required = checker.getPropertiesOfType(uowType);
  if (required.length === 0) return false;
  const candidateProps = new Set(checker.getPropertiesOfType(type).map((p) => p.name));
  return required.every((p) => candidateProps.has(p.name));
}

/* ============================================================================
 * Task 2：edge 级枚举 —— A1-A4 接收 + B1-B8 转移全形态 + findDbCapabilityPaths。
 *
 * 核心不变量（与 Task 1 一致）：宁可 fail-closed（未知边界/预算超限 → unknown-boundary
 * edge → 门红），也绝不「漏扫却报绿」。任何 checker/API 异常带 node/file context 重抛。
 * ==========================================================================*/

/** findDbCapabilityPaths 递归预算：防病态深/宽类型图导致无限/超时递归。超限 → unknown-boundary。 */
const CAPABILITY_MAX_DEPTH = 12;
const CAPABILITY_MAX_NODES = 4000;

/**
 * 递归查某类型携带 DB 能力的**完整属性路径**（Codex 第 3 轮 #2 的「含 DB 能力」正式谓词）。
 *
 * 整体类型不可赋 UoW（如 `{ db: IDatabase }`、`IDatabase[]`）时，isDbCapabilityType 不够，
 * 需递归其属性 / union·intersection 分量 / tuple·array element，记完整 property path。
 *
 * 返回 CapabilityPath[]：
 *   - `{ path: [] }`：type 本身即 DB 能力（直接命中）。
 *   - `{ path: ['db'] }` / `{ path: ['options', 'db'] }`：内部路径命中。
 *   - `{ unknown: true, context }`：预算超限——由调用点产 unknown-boundary edge（门红）。
 *
 * **visited = 当前递归栈 active-set**（进入 type 前加入、退出该分支后移除），**非全局**：
 * 全局会漏 `{ primary: IDatabase; replica: IDatabase }` 的第二条 path（IDatabase 首访后被
 * 全局标记 → replica 被跳过）。active-set 仅防真环，允许同一 type 经不同父路径重复展开。
 *
 * @param {import('typescript').Type} type
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} uowType
 * @param {{ node?: import('typescript').Node, file?: string }} [ctx] 供异常/unknown-boundary 带上下文。
 * @returns {Array<{ path: string[] } | { unknown: true, context: string }>}
 */
export function findDbCapabilityPaths(type, checker, uowType, ctx = {}) {
  const state = { nodes: 0 };
  const active = new Set();
  const out = [];
  recurseCapability(type, [], checker, uowType, active, state, out, 0, ctx);
  return out;
}

/**
 * findDbCapabilityPaths 的递归内核。
 *
 * 关键顺序（Codex 第 4 轮 #4 的 active-stack 语义）：
 *   1. 先判环 / 预算超限。
 *   2. **把当前 type 加入 active 集**（在判 isDbCapabilityType 之前——这样容器 type 在
 *      其属性递归期间处于 active，退出该分支后移除，允许兄弟属性重新展开同一 type）。
 *   3. isDbCapabilityType(type) → 命中即 push { path }，不再深入（DB 能力是叶子）。
 *   4. 否则递归 union/intersection 分量、object 属性、tuple/array element。
 *   5. **finally 从 active 移除**（active-set 语义；改成不移除即退化为全局 visited）。
 */
function recurseCapability(type, path, checker, uowType, active, state, out, depth, ctx) {
  if (!type) return;
  if (depth > CAPABILITY_MAX_DEPTH || state.nodes > CAPABILITY_MAX_NODES) {
    out.push({ unknown: true, context: `${ctx.file ?? '?'}: capability 递归预算超限 @ ${path.join('.') || '<root>'}` });
    return;
  }
  if (active.has(type)) return; // 真环：当前栈已在展开此 type，跳过（防无限递归）。
  state.nodes += 1;
  active.add(type);
  try {
    // 叶子：type 本身即 DB 能力（含 union/intersection/generic——isDbCapabilityType 内处理）。
    if (isDbCapabilityType(type, checker, uowType)) {
      out.push({ path: [...path] });
      return;
    }
    // union/intersection 分量：逐分量以**相同** path 前缀展开。
    if (type.isUnion?.() || type.isIntersection?.()) {
      for (const t of type.types) {
        recurseCapability(t, path, checker, uowType, active, state, out, depth + 1, ctx);
      }
      return;
    }
    // tuple / array element：`IDatabase[]` / `[IDatabase, X]` → path 加 '[]'。
    const elementType = getArrayLikeElementType(type, checker);
    if (elementType) {
      recurseCapability(elementType, [...path, '[]'], checker, uowType, active, state, out, depth + 1, ctx);
      return;
    }
    // object 属性：逐属性以 path+[propName] 展开（如 options.db、primary、replica）。
    const props = checker.getPropertiesOfType(type);
    for (const prop of props) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const propType = decl
        ? checker.getTypeOfSymbolAtLocation(prop, decl)
        : checker.getDeclaredTypeOfSymbol(prop);
      recurseCapability(propType, [...path, prop.name], checker, uowType, active, state, out, depth + 1, ctx);
    }
  } catch (err) {
    // fail-closed：checker 抛异常 → 带 context 重抛（绝不吞成「无能力」空扫报绿）。
    throw new Error(
      `findDbCapabilityPaths 异常 @ ${ctx.file ?? '?'} path=${path.join('.') || '<root>'}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    active.delete(type); // active-set 语义：退出本分支移除（改成注释掉此行即变全局 visited）。
  }
}

/** array / ReadonlyArray / tuple 的 element type（无则 undefined）。用于 tuple·array element 递归。 */
function getArrayLikeElementType(type, checker) {
  if (checker.isArrayType?.(type) || checker.isTupleType?.(type)) {
    const args = checker.getTypeArguments?.(/** @type {import('typescript').TypeReference} */(type)) ?? [];
    if (args.length === 1) return args[0];
    if (args.length > 1) {
      // tuple：合成 union 供逐 element 判定（简化——element 里任一 DB 能力即命中）。
      return checker.getUnionType?.(args) ?? args[0];
    }
  }
  return undefined;
}

/**
 * 枚举一个 Program 内所有携带 DB 能力的 source→sink edge（edge 级，不按 owner 合并）。
 *
 * 遍历两组有限 boundary（Codex 多轮逼出的 taxonomy）：
 *   A 接收/存储（sink declaration）：A1 function-like 参数 / A2 parameter property /
 *     A3 PropertyDeclaration / A4 PropertySignature。
 *   B 转移：B1 decl·param·binding initializer / B2 call·new argument / B3 assignment /
 *     B4 aggregate wrapping / B5 return·yield / B6 collection write / B7 closure capture /
 *     B8 module·export。
 *
 * 每个 boundary 取其类型（getTypeAtLocation，不要求显式 node.type）跑 findDbCapabilityPaths 三态：
 *   ① 空（无能力路径）→ 跳过；② 有能力可归 kind → known edge；
 *   ③ 有能力不可分类 / 预算超限 → unknown-boundary edge（门红）。
 *
 * @param {import('typescript').Program} program
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').Type} uowType
 * @param {{ includeTests?: boolean }} [opts] includeTests=false 时排除 src/test/**（主门 production scope）。
 * @returns {import('./db-sink-scanner.d.mts').Edge[]}
 */
export function enumerateDbCapabilityEdges(program, checker, uowType, opts = {}) {
  const { includeTests = false } = opts;
  const edges = [];
  const seen = new Set(); // 去重：完全相同 id 只留一条（edge 级，不按 owner 合并）。

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue; // .d.ts 契约不产 edge。
    const rel = relative(ROOT, sf.fileName);
    if (rel.startsWith('..') || rel.includes('node_modules')) continue;
    const isTest = rel.startsWith('src/test/');
    if (isTest && !includeTests) continue;

    const ctx = { file: rel };
    // 先算 capture（B7）：收集被嵌套闭包捕获的外层绑定 symbol → 供 acceptance 压制。
    const captured = collectCaptures(sf, checker, uowType, rel, edges, seen, ctx);
    // 再遍历 acceptance（A1-A4）+ 其余 transfer（B1-B6, B8）。
    walkBoundaries(sf, checker, uowType, rel, edges, seen, ctx, captured);
  }
  return edges;
}

/** 压制/去重后 push 一条 edge（id = <file>#<owner>::<kind>::<target>::<param>）。 */
function pushEdge(edges, seen, rel, owner, kind, target, param) {
  const id = `${rel}#${owner}::${kind}::${target}::${param}`;
  if (seen.has(id)) return;
  seen.add(id);
  edges.push({ id, file: rel, owner, kind, target, param });
}

/** unknown-boundary edge（三态③）：有 DB 能力但不可分类/预算超限 → 门红。 */
function pushUnknown(edges, seen, rel, owner, target, param, context) {
  const id = `${rel}#${owner}::unknown-boundary::${target}::${param}`;
  if (seen.has(id)) return;
  seen.add(id);
  edges.push({ id, file: rel, owner, kind: 'unknown-boundary', target, param, context });
}

/* ---------------------------------------------------------------------------
 * capture（B7）：函数体内引用**作用域外** DB 绑定。
 * 返回被捕获的绑定 symbol 集合（供 acceptance 压制——参数被捕获则只报 capture）。
 * ------------------------------------------------------------------------ */
function collectCaptures(sf, checker, uowType, rel, edges, seen, ctx) {
  const capturedSymbols = new Set();
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      // 对每个 function-like，检查其体内引用的、声明在**更外层函数作用域**的 DB 绑定。
      collectCapturesInClosure(node, node, checker, uowType, rel, edges, seen, ctx, capturedSymbols);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return capturedSymbols;
}

/** 在 closure 体内找引用外层函数作用域 DB 绑定的 Identifier（捕获）。 */
function collectCapturesInClosure(closure, ownerFn, checker, uowType, rel, edges, seen, ctx, capturedSymbols) {
  const scan = (node) => {
    // 只在**嵌套的**内层 function-like 里算捕获（closure 本身的直接体不算捕获自己的参数）。
    if (node !== closure && ts.isFunctionLike(node) && node.body) {
      collectNestedRefs(node, node, checker, uowType, rel, edges, seen, ctx, capturedSymbols);
      return; // 内层自己会继续递归其体。
    }
    ts.forEachChild(node, scan);
  };
  if (closure.body) ts.forEachChild(closure.body, scan);
}

/** 内层闭包体内所有引用外层函数作用域 DB 绑定的 Identifier → capture edge。 */
function collectNestedRefs(inner, innerRoot, checker, uowType, rel, edges, seen, ctx, capturedSymbols) {
  const scan = (node) => {
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      let sym;
      try {
        sym = checker.getSymbolAtLocation(node);
      } catch (err) {
        throw new Error(`capture getSymbolAtLocation 异常 @ ${rel}:${node.text}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      const decl = sym && (sym.valueDeclaration ?? sym.declarations?.[0]);
      if (decl && isDeclaredInOuterFunctionScope(decl, innerRoot)) {
        const type = safeTypeAtLocation(checker, decl, rel);
        if (isDbCapabilityType(type, checker, uowType)) {
          const ownerFn = findEnclosingFunctionScope(decl); // 拥有该绑定的函数（capture owner/target）。
          const ownerName = describeOwner(ownerFn, checker) ?? '<module>';
          pushEdge(edges, seen, rel, ownerName, 'capture', ownerName, node.text);
          capturedSymbols.add(sym);
        }
      }
    }
    ts.forEachChild(node, scan);
  };
  if (inner.body) ts.forEachChild(inner.body, scan);
}

/** decl 是否声明在 innerRoot（内层闭包）**之外**的某个函数作用域内（真捕获，非本地）。 */
function isDeclaredInOuterFunctionScope(decl, innerRoot) {
  // decl 必须是函数作用域内的绑定（Parameter / 局部 VariableDeclaration），且不在 innerRoot 子树内。
  if (isAncestor(innerRoot, decl)) return false; // 声明在内层自己里 → 本地，不算捕获。
  const scope = findEnclosingFunctionScope(decl);
  if (!scope) return false; // module 顶层绑定不算「闭包捕获」（是 module scope，另有 B8）。
  return true;
}

/** a 是否为 b 的祖先节点。 */
function isAncestor(a, b) {
  let cur = b;
  while (cur) {
    if (cur === a) return true;
    cur = cur.parent;
  }
  return false;
}

/** 找 node 所在的最近 function-like 作用域（不含 node 自身若它就是 function-like 的话取其父）。 */
function findEnclosingFunctionScope(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isFunctionLike(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
 * acceptance（A1-A4）+ 其余 transfer（B1-B6, B8）遍历。
 * ------------------------------------------------------------------------ */
function walkBoundaries(sf, checker, uowType, rel, edges, seen, ctx, captured) {
  const consumed = new Set(); // 被更具体 boundary 消费的表达式（防 new-arg 对象字面量再被 aggregate 重复计）。

  const visit = (node) => {
    // ---- A. acceptance（declaration sinks）----
    if (ts.isParameter(node) && !isInAmbientContext(node)) {
      handleParameterAcceptance(node, checker, uowType, rel, edges, seen, ctx, captured);
    } else if (ts.isPropertyDeclaration(node) && !isInAmbientContext(node)) {
      handlePropertyAcceptance(node, 'field-decl', checker, uowType, rel, edges, seen, ctx);
    } else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && !isInAmbientContext(node)) {
      // A4：具名 deps 契约（interface / type-alias），对**整体类型**一次性递归——
      // 由此让 pair.ts 的 primary/replica 共享**同一** active-stack（active-stack canary）。
      handleDepsContractAcceptance(node, checker, uowType, rel, edges, seen, ctx);
    }

    // ---- B. transfer ----
    if (ts.isExportAssignment(node)) {
      handleExportAssignment(node, checker, uowType, rel, edges, seen, ctx);
    } else if (ts.isExportDeclaration(node)) {
      handleExportDeclaration(node, checker, uowType, rel, edges, seen, ctx);
    } else if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      handleCallOrNew(node, checker, uowType, rel, edges, seen, ctx, consumed);
    } else if (ts.isReturnStatement(node) || ts.isYieldExpression(node)) {
      handleReturnYield(node, checker, uowType, rel, edges, seen, ctx, consumed);
    } else if (isTrackedAssignment(node)) {
      handleAssignment(node, checker, uowType, rel, edges, seen, ctx, consumed);
    } else if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      handleAggregate(node, checker, uowType, rel, edges, seen, ctx, consumed);
    } else if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && node.initializer) {
      handleDeclInitializer(node, checker, uowType, rel, edges, seen, ctx, consumed);
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}

/** A1/A2：function-like 参数（含 parameter property）。
 *
 * A1 用 **ts.isFunctionLike** 判定 enclosing 是否为 function-like——这是覆盖
 * FunctionExpression / SetAccessor / GetAccessor / Method / Ctor / Arrow /
 * 类型层签名（MethodSignature/CallSignature/ConstructSignature/FunctionTypeNode）的**权威**判据，
 * 绝不手列节点（手列极易漏 FunctionExpression / setter）。变异自证：把此处 ts.isFunctionLike
 * 换成手列不含 FunctionExpression 的集合 → function-like.ts 的 fnExpr edge 消失，其 deepEqual 变红。 */
function handleParameterAcceptance(param, checker, uowType, rel, edges, seen, ctx, captured) {
  if (!ts.isIdentifier(param.name)) return; // 解构参数由 findDbCapabilityPaths 内部路径覆盖，此处只处理具名。
  const fn = param.parent;
  if (!ts.isFunctionLike(fn)) return; // A1 权威判据：非 function-like 的参数位置不产 acceptance。
  const sym = safeSymbol(checker, param.name, rel);
  if (sym && captured.has(sym)) return; // 被嵌套闭包捕获 → 只报 capture（precedence），压制 acceptance。
  const type = safeTypeAtLocation(checker, param, rel);
  const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
  if (paths.length === 0) return;
  const kind = paramAcceptanceKind(fn);
  const { owner, target } = describeFunctionOwnerTarget(fn, checker);
  emitPathsAsEdges(paths, param.name.text, edges, seen, rel, owner, kind, target, ctx);
}

/** A3：class 字段（PropertyDeclaration，有无 initializer 都算）。 */
function handlePropertyAcceptance(prop, kind, checker, uowType, rel, edges, seen, ctx) {
  if (!ts.isIdentifier(prop.name)) return;
  const type = safeTypeAtLocation(checker, prop, rel);
  const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
  if (paths.length === 0) return;
  const cls = findEnclosingClassName(prop) ?? '<anonymous>';
  emitPathsAsEdges(paths, prop.name.text, edges, seen, rel, cls, kind, cls, ctx);
}

/** A4：具名 deps 契约（interface / type-alias）。
 *
 * 对**整体**类型一次性 findDbCapabilityPaths（**共享同一 active-stack**）——这是 pair.ts 的
 * active-stack canary 生效前提：`{ primary: IDatabase; replica: IDatabase }` 的两个属性在**一次**
 * 递归里探测，全局 visited 会在探完 primary 后把 IDatabase 永久标记 → 漏 replica；active-set
 * 退出 primary 分支即移除 → replica 重新展开。每条 top-level capability path → 一条 deps-prop
 * edge，param = path（如 primary/replica/db，嵌套则 db.nested）。
 *
 * 内联 type-literal（函数返回/参数类型里的 `{ db }`）不是具名契约，此处不处理——由使用它的
 * return/parameter/call 边界覆盖，不重复产 deps-prop edge。 */
function handleDepsContractAcceptance(node, checker, uowType, rel, edges, seen, ctx) {
  const owner = node.name.text;
  const type = safeTypeAtLocation(checker, node.name, rel);
  const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
  for (const p of paths) {
    if (p.unknown) {
      pushUnknown(edges, seen, rel, owner, owner, '<value>', p.context);
      continue;
    }
    // top-level path 即 deps 契约里的属性路径（无 path 段则整体即 DB，退化为 owner 自身）。
    const param = p.path.length ? p.path.join('.') : owner;
    pushEdge(edges, seen, rel, owner, 'deps-prop', owner, param);
  }
}

/** B8：export default X / export = X。 */
function handleExportAssignment(node, checker, uowType, rel, edges, seen, ctx) {
  const type = safeTypeAtLocation(checker, node.expression, rel);
  const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
  if (paths.length === 0) return;
  const param = ts.isIdentifier(node.expression) ? node.expression.text : 'default';
  emitPathsAsEdges(paths, param, edges, seen, rel, '<module>', 'module-export', 'default', ctx);
}

/** B8：export { db2 } / export { db as default }。 */
function handleExportDeclaration(node, checker, uowType, rel, edges, seen, ctx) {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return;
  for (const spec of node.exportClause.elements) {
    const local = spec.propertyName ?? spec.name;
    const type = safeTypeAtLocation(checker, local, rel);
    const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
    if (paths.length === 0) continue;
    emitPathsAsEdges(paths, local.text, edges, seen, rel, '<module>', 'module-export', 'named', ctx);
  }
}

/** B2 / B6：new/call 实参携带 DB 能力（用 resolved signature 的参类型跑 findDbCapabilityPaths）。 */
function handleCallOrNew(node, checker, uowType, rel, edges, seen, ctx, consumed) {
  const args = node.arguments ?? [];
  if (args.length === 0) return;
  let signature;
  try {
    signature = checker.getResolvedSignature(node);
  } catch (err) {
    throw new Error(`getResolvedSignature 异常 @ ${rel}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const params = signature?.getParameters?.() ?? [];
  const calleeName = describeCallee(node);
  const owner = describeEnclosingOwner(node, checker);
  const isCollectionWrite = ts.isCallExpression(node) && isCollectionWriteCallee(node);
  const kind = isCollectionWrite ? 'collection-write' : 'factory-indirect';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    // 取「参数声明类型」——包裹如 options:{db} 的整体不可赋 UoW，靠 findDbCapabilityPaths 找 options.db。
    const paramSym = params[i] ?? params[params.length - 1]; // rest 参数回退到最后一个。
    let paramType;
    let paramName = `arg${i}`;
    if (paramSym) {
      const decl = paramSym.valueDeclaration ?? paramSym.declarations?.[0];
      paramType = decl ? checker.getTypeOfSymbolAtLocation(paramSym, decl) : undefined;
      paramName = paramSym.getName?.() ?? paramName;
    }
    if (!paramType) paramType = safeTypeAtLocation(checker, arg, rel); // 无签名信息 → 退回实参类型。
    const paths = findDbCapabilityPaths(paramType, checker, uowType, ctx);
    if (paths.length === 0) continue;
    consumed.add(arg); // 该实参被 call/new 边界消费，aggregate/decl-init 不再重复计。
    emitPathsAsEdges(paths, paramName, edges, seen, rel, owner, kind, calleeName, ctx);
  }
}

/** B5：return / yield 携带 DB 能力。 */
function handleReturnYield(node, checker, uowType, rel, edges, seen, ctx, consumed) {
  const expr = node.expression;
  if (!expr) return;
  const type = safeTypeAtLocation(checker, expr, rel);
  const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
  if (paths.length === 0) return;
  consumed.add(expr); // return 位置的对象字面量被 return 边界消费。
  const owner = describeEnclosingOwner(node, checker);
  // 直接命中（return db）→ param=标识符名；内部路径（return {db}）→ param=path。
  const baseName = ts.isIdentifier(expr) ? expr.text : undefined;
  emitPathsAsEdges(paths, baseName, edges, seen, rel, owner, 'return', 'return', ctx);
}

/** B3：assignment（= / ||= / &&= / ??=），含 this.db = ...。 */
function handleAssignment(node, checker, uowType, rel, edges, seen, ctx, consumed) {
  const rhs = node.right;
  const type = safeTypeAtLocation(checker, rhs, rel);
  const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
  if (paths.length === 0) return;
  consumed.add(rhs);
  const owner = describeEnclosingOwner(node, checker);
  const target = node.left.getText(node.getSourceFile());
  const baseName = ts.isIdentifier(rhs) ? rhs.text : undefined;
  emitPathsAsEdges(paths, baseName, edges, seen, rel, owner, 'assignment', target, ctx);
}

/** B4：aggregate wrapping（object/array literal，未被更具体边界消费时）。 */
function handleAggregate(node, checker, uowType, rel, edges, seen, ctx, consumed) {
  if (consumed.has(node)) return; // 已被 call/new/return/assignment 消费。
  const type = safeTypeAtLocation(checker, node, rel);
  const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
  if (paths.length === 0) return;
  const owner = describeEnclosingOwner(node, checker);
  const target = ts.isArrayLiteralExpression(node) ? 'array' : 'object';
  // param：spread（{...deps}）→ '...deps'；否则用能力 path。
  const spread = findSpreadParam(node);
  if (spread) {
    pushEdge(edges, seen, rel, owner, 'aggregate-wrapping', target, `...${spread}`);
    return;
  }
  emitPathsAsEdges(paths, undefined, edges, seen, rel, owner, 'aggregate-wrapping', target, ctx);
}

/** object/array literal 里携带 DB 能力的 spread 源标识符名（如 {...deps} → 'deps'）。 */
function findSpreadParam(node) {
  const elements = ts.isObjectLiteralExpression(node) ? node.properties : node.elements;
  for (const el of elements) {
    if (ts.isSpreadAssignment(el) && ts.isIdentifier(el.expression)) return el.expression.text;
    if (ts.isSpreadElement?.(el) && ts.isIdentifier(el.expression)) return el.expression.text;
  }
  return undefined;
}

/** B1：decl / param / binding initializer 携带 DB 能力（未被更具体边界消费时）。 */
function handleDeclInitializer(node, checker, uowType, rel, edges, seen, ctx, consumed) {
  const init = node.initializer;
  if (!init || consumed.has(init)) return;
  // 对象/数组字面量初始化由 aggregate 处理；call/new 由 handleCallOrNew 处理——此处只管「直接标识符/其它」。
  if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) return;
  if (ts.isNewExpression(init) || ts.isCallExpression(init)) return;
  const type = safeTypeAtLocation(checker, init, rel);
  const paths = findDbCapabilityPaths(type, checker, uowType, ctx);
  if (paths.length === 0) return;
  const owner = describeEnclosingOwner(node, checker);
  const target = ts.isIdentifier(node.name) ? node.name.text : 'binding';
  const baseName = ts.isIdentifier(init) ? init.text : undefined;
  emitPathsAsEdges(paths, baseName, edges, seen, rel, owner, 'decl-init', target, ctx);
}

/* ---------------------------------------------------------------------------
 * 辅助：把 CapabilityPath[] 落成 edge（三态②/③）。
 * ------------------------------------------------------------------------ */
function emitPathsAsEdges(paths, baseName, edges, seen, rel, owner, kind, target, ctx) {
  for (const p of paths) {
    if (p.unknown) {
      pushUnknown(edges, seen, rel, owner, target, baseName ?? '<expr>', p.context);
      continue;
    }
    // param：baseName（声明名/标识符）+ 能力后缀 path。直接命中且有 baseName → 仅 baseName。
    let param;
    if (baseName) {
      param = p.path.length ? `${baseName}.${p.path.join('.')}` : baseName;
    } else {
      param = p.path.length ? p.path.join('.') : '<value>';
    }
    pushEdge(edges, seen, rel, owner, kind, target, param);
  }
}

/* ---------------------------------------------------------------------------
 * 辅助：owner / target / kind 推导。
 * ------------------------------------------------------------------------ */

/** A1/A2 参数的 kind：ctor→ctor-param / FunctionDeclaration→route-param / 其余→fn-param。 */
function paramAcceptanceKind(fn) {
  if (ts.isConstructorDeclaration(fn)) return 'ctor-param';
  if (ts.isFunctionDeclaration(fn)) return 'route-param';
  return 'fn-param'; // FunctionExpression / ArrowFunction / Method / accessor / 签名。
}

/** function-like 的 owner / target 名。 */
function describeFunctionOwnerTarget(fn, checker) {
  // constructor：owner=target=类名。
  if (ts.isConstructorDeclaration(fn)) {
    const cls = findEnclosingClassName(fn) ?? '<anonymous>';
    return { owner: cls, target: cls };
  }
  // setter / getter：owner=类名.访问器名，target='set 名' / 'get 名'。
  if (ts.isSetAccessorDeclaration(fn) || ts.isGetAccessorDeclaration(fn)) {
    const cls = findEnclosingClassName(fn);
    const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : '<accessor>';
    const kw = ts.isSetAccessorDeclaration(fn) ? 'set' : 'get';
    return { owner: cls ? `${cls}.${name}` : name, target: `${kw} ${name}` };
  }
  // method：owner=类名.方法名，target=方法名。
  if (ts.isMethodDeclaration(fn)) {
    const cls = findEnclosingClassName(fn);
    const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : '<method>';
    return { owner: cls ? `${cls}.${name}` : name, target: name };
  }
  // FunctionDeclaration：owner=target=函数名。
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    return { owner: fn.name.text, target: fn.name.text };
  }
  // FunctionExpression / ArrowFunction：取被赋值的变量名（const fnExpr = function(){}）。
  const varName = findAssignedVariableName(fn);
  if (varName) return { owner: varName, target: varName };
  return { owner: '<anonymous>', target: '<anonymous>' };
}

/** 找 owner（转移边界所在的最近命名作用域：函数/方法/访问器名，否则 <module>）。 */
function describeEnclosingOwner(node, checker) {
  const fn = findEnclosingFunctionScope(node);
  if (!fn) return '<module>';
  return describeOwner(fn, checker) ?? '<module>';
}

/** 单个 function-like 的 owner 名（供 capture / transfer 复用）。 */
function describeOwner(fn, checker) {
  if (ts.isConstructorDeclaration(fn)) return findEnclosingClassName(fn) ?? '<anonymous>';
  if (ts.isSetAccessorDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isMethodDeclaration(fn)) {
    const cls = findEnclosingClassName(fn);
    const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : '<member>';
    return cls ? `${cls}.${name}` : name;
  }
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  const varName = findAssignedVariableName(fn);
  return varName ?? '<anonymous>';
}

/** FunctionExpression/Arrow 被赋给的变量名（const fnExpr = function(){} → 'fnExpr'）。 */
function findAssignedVariableName(fn) {
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

/** 最近 class 名。 */
function findEnclosingClassName(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) {
      return cur.name && ts.isIdentifier(cur.name) ? cur.name.text : '<anonymous-class>';
    }
    cur = cur.parent;
  }
  return undefined;
}

/** new/call 的 callee 名（identifier / property-access 末段）。 */
function describeCallee(node) {
  const expr = node.expression;
  if (!expr) return '<callee>';
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return expr.getText(node.getSourceFile());
}

/** 是否 collection write（arr.push / map.set / set.add）。 */
function isCollectionWriteCallee(node) {
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return false;
  return ['push', 'set', 'add', 'unshift'].includes(expr.name.text);
}

/** 是否为需追踪的赋值 BinaryExpression（= / ||= / &&= / ??=）。 */
function isTrackedAssignment(node) {
  if (!ts.isBinaryExpression(node)) return false;
  const op = node.operatorToken.kind;
  return (
    op === ts.SyntaxKind.EqualsToken ||
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    op === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

/** identifier 是否处于「声明名」位置（不是引用）——供 capture 排除声明本身。 */
function isDeclarationName(node) {
  const p = node.parent;
  if (!p) return false;
  return (
    (ts.isParameter(p) && p.name === node) ||
    (ts.isVariableDeclaration(p) && p.name === node) ||
    (ts.isBindingElement(p) && p.name === node) ||
    (ts.isPropertyDeclaration(p) && p.name === node) ||
    (ts.isPropertySignature(p) && p.name === node) ||
    (ts.isFunctionDeclaration(p) && p.name === node) ||
    (ts.isPropertyAssignment(p) && p.name === node)
  );
}

/** 节点是否在 ambient（declare）上下文——acceptance 跳过外部契约桩。 */
function isInAmbientContext(node) {
  let cur = node;
  while (cur) {
    if (cur.modifiers && cur.modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
    if (
      (ts.isVariableStatement(cur) || ts.isFunctionDeclaration(cur) || ts.isClassDeclaration(cur) || ts.isModuleDeclaration(cur)) &&
      ts.getCombinedModifierFlags(cur) & ts.ModifierFlags.Ambient
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** getTypeAtLocation 带 fail-closed（异常带 context 重抛，绝不吞成 undefined 空扫）。 */
function safeTypeAtLocation(checker, node, rel) {
  try {
    return checker.getTypeAtLocation(node);
  } catch (err) {
    throw new Error(`getTypeAtLocation 异常 @ ${rel}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** getSymbolAtLocation 带 fail-closed。 */
function safeSymbol(checker, node, rel) {
  try {
    return checker.getSymbolAtLocation(node);
  } catch (err) {
    throw new Error(`getSymbolAtLocation 异常 @ ${rel}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * 纯比较：edge id 不在 inventory 集合中 → 未登记（无路径过滤）。
 * @param {import('./db-sink-scanner.d.mts').Edge[]} edges
 * @param {Set<string>} inventoryIds
 * @returns {import('./db-sink-scanner.d.mts').Edge[]}
 */
export function collectUnregisteredEdges(edges, inventoryIds) {
  return edges.filter((e) => !inventoryIds.has(e.id));
}
