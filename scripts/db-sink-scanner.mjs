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
