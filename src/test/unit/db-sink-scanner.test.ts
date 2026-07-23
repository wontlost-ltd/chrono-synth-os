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
import { buildProgram, isDbCapabilityType } from '../../../scripts/db-sink-scanner.mjs';

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

test('canonical DB/UoW type 解析成功（否则 fail-closed）', () => {
  const { uowType } = buildProgram('tsconfig.src.json');
  assert.ok(uowType, 'canonical SyncWriteUnitOfWork 未解析——扫描器应 fail-closed 而非空扫');
});

test('类型判定：canonical/alias/结构兼容(纯UoW)/union/generic 都判 DB 能力；negative 不判', () => {
  const { program, checker, uowType } = buildProgram('tsconfig.src.json');
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
