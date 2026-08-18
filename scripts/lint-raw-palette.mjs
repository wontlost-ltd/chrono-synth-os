#!/usr/bin/env node
/**
 * 禁止在 apps/web 直接使用 Tailwind 裸调色板色（text-gray-500 / bg-blue-600 …）。
 *
 * 为什么需要这道门：`lint:contrast` 是基于**语义 token 对**做计算的，
 * 结构上看不见硬编码的调色板色——所以 `text-gray-600`（在 dark canvas 上
 * 只有 2.63，远低于 AA 4.5）这类问题它一个都抓不到。axe E2E 能抓，但只覆盖
 * 已纳入路由清单且默认渲染出来的节点。这道静态门补的就是这两者之间的缝。
 *
 * 历史：迁移前 apps/web 有 124 处裸 gray，其中 45 处作文本用且实测不达 AA
 * （gray-500 4.11 / gray-600 2.63 / gray-700 1.93）。
 *
 * 允许清单（ALLOW）只用于确有理由的例外，新增须在此写明原因。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET = join(ROOT, 'apps/web/src');

/** Tailwind 默认调色板色名——语义 token（surface/text/border/primary…）不在此列。 */
const PALETTE = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];
const UTIL = 'text|bg|border|ring|from|to|via|divide|outline|decoration|shadow|fill|stroke|placeholder|accent|caret';
const RE = new RegExp(`\\b(?:${UTIL})-(?:${PALETTE.join('|')})-\\d{2,3}\\b`, 'g');

/**
 * 任意值语法 `text-[#818CF8]` / `bg-[rgba(...)]`——绕开调色板类名，
 * 但同样是硬编码色，两道既有门都看不见。
 */
const ARBITRARY_RE = new RegExp(`\\b(?:${UTIL})-\\[(?:#[0-9a-fA-F]{3,8}|rgba?\\([^\\]]*\\))\\]`, 'g');

/**
 * 组件源码里的裸 hex（`.tsx`/`.ts` 才查；`.css` 里主要是 codegen 产物与
 * 主题定义，本就该是 hex）。
 *
 * 合法例外**不算违规**，直接在匹配阶段排除：
 *   - `var(--token, #fallback)` 的兜底值——token 缺失时的降级，是推荐写法
 *   - 注释里提到的色值——写迁移说明时必然要引用旧值
 */
/* 只认「合法长度」的 hex（3/4/6/8 位），并排除非颜色写法：
 *   - HTML 实体 `&#8203;`（零宽空格等，排版常见，4 位数字恰好像 hex）
 *   - 前面紧跟字母/数字的片段（URL fragment、DOM id 选择器）
 *
 * ⚠️ `#a1b2c3` 这种既是合法 hex 又是合法 commit sha 前缀，纯靠字面无法区分。
 * 故要求它出现在**引号紧邻处**——即真正当色值写的形态
 * （`'#abc'` / `"#abc"` / `` `#abc` `` / `: '#abc'`）；散在自由文本里的
 * sha、issue 号一律不报。代价是 `` `${x}#abc` `` 这类拼接会漏，
 * 但那本就是动态值、静态分析抓不到。 */
const HEX_RE = /(?<=['"`])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?=['"`])/g;
const VAR_FALLBACK_RE = /var\(\s*--[\w-]+\s*,\s*[^)]*\)/g;

/* 函数式色值：hsl/oklch/lab/lch/裸 rgb——不是 hex 也不是调色板类名，
 * 两道既有门都看不见。CLAUDE.md 的 frontend-design 域推荐 OKLCH，
 * 不补这条的话将来写 oklch() 会完全绕过本门。 */
const COLOR_FN_RE = /\b(?:hsla?|oklch|oklab|lch|lab)\(|(?<!\w)rgba?\(\s*\d/g;

/**
 * 例外清单：`文件相对路径 → 原因`。
 * 空清单即「零容忍」；确需例外时在此登记，让下一个人看得到理由。
 */
const ALLOW = new Map([
  /* 空。整文件豁免只保留给「整个文件都是色板定义」这类极端情况——
   * 日常例外一律用行级 `lint-raw-palette-ignore-next-line/-block` 标记，
   * 见下方说明。原先这里有 6 个文件级豁免（共掩盖 56 处），已全部下沉为
   * 22 个行/块级标记，各自带原因。 */
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    /* 断掉的符号链接会让 statSync 抛 ENOENT——若不接住，这道门就变成
     * 「崩出一段堆栈」而不是「给出检查结论」，属于 fail-open 的坏形态。 */
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      console.warn(`  ⚠ 跳过无法访问的路径（${err.code}）：${relative(ROOT, p)}`);
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * 行级豁免标记（取代整文件豁免）。写法：
 *
 *   // lint-raw-palette-ignore-next-line 原因
 *   const LOAD_COLOR = { idle: '#9ca3af' };
 *
 *   // lint-raw-palette-ignore-block 原因      ← 覆盖到下一个空行为止
 *   const PALETTE = {
 *     cyan: '#22D3EE',
 *     indigo: '#6366F1',
 *   };
 *
 * 相比整文件豁免的好处：豁免范围收敛到**具体几行**，该文件里**将来新增**
 * 的硬编码色仍会被拦下（整文件豁免会静默放过——已用变异测试实证）。
 * 原因必须写在标记后面，让下一个人看得到为什么。
 */
/** ignore-block 单次最多覆盖的行数——当前最大的实际块是 9 行（EnterpriseConsole 渐变表）。 */
const BLOCK_MAX = 12;
/**
 * 原因是否「像个原因」——只判非空的话，`x` / `.` / `,,,,` 都能过关，
 * 达不到「让下一个人看得到为什么」的目的。要求 ≥6 个非标点字符。
 */
function hasRealReason(raw) {
  const t = (raw || '').replace(/\*\/\s*$/, '').trim();
  return t.replace(/[\s\p{P}\p{S}]/gu, '').length >= 6;
}

const IGNORE_LINE = /\/\/\s*lint-raw-palette-ignore-next-line\b(.*)$|\/\*\s*lint-raw-palette-ignore-next-line\b([^*]*)\*\//;
const IGNORE_BLOCK = /\/\/\s*lint-raw-palette-ignore-block\b(.*)$|\/\*\s*lint-raw-palette-ignore-block\b([^*]*)\*\//;

let violations = 0;
let scanned = 0;
let missingReason = 0;
for (const file of walk(TARGET)) {
  const rel = relative(join(ROOT, 'apps/web'), file);
  scanned += 1;
  if (ALLOW.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  const isComponent = /\.tsx?$/.test(file);
  /* 逐行剥注释：块注释要跨行跟踪状态，否则多行迁移说明里引用的旧色值
   * （如「原 neutral-3(#64748B)」）会被误报。 */
  let inBlockComment = false;
  const lines = text.split('\n');
  /* 先扫一遍标记，算出被豁免的行号集合（标记本身写在注释里，
   * 下面剥注释时会被抹掉，故必须在剥之前采集）。 */
  const exempt = new Set();
  lines.forEach((line, i) => {
    /* 标记必须是**真注释**：`"// lint-raw-palette-ignore-next-line"` 这种
     * 写在字符串字面量里的假指令不算数，否则任何人都能用一行字符串关掉门。
     * 判据——标记前面若出现未闭合的引号，说明它落在字符串内。 */
    const markerAt = line.search(/\/[/*]\s*lint-raw-palette-ignore-/);
    if (markerAt >= 0) {
      const before = line.slice(0, markerAt);
      const odd = (q) => (before.split(q).length - 1) % 2 === 1;
      if (odd("'") || odd('"') || odd('`')) return; // 在字符串里，忽略
    }
    const mb = line.match(IGNORE_BLOCK);
    if (mb) {
      if (!hasRealReason(mb[1] || mb[2])) {
        missingReason += 1;
        console.error(`  ✖ ${rel}:${i + 1}  ignore-block 缺原因说明（需 ≥6 个非标点字符）`);
      }
      /* 覆盖到下一个空行为止——正好对应「一个声明块」。
       *
       * ⚠️ 上限 BLOCK_MAX 行：没有空行的长文件（压缩代码、超大对象）会让
       * 「到下一个空行」一路吞到文件尾，把无关声明也豁免掉——那比整文件豁免
       * 更隐蔽。实测无上限时一个 60 行对象后面紧跟的独立声明也被吞掉。
       * 超限即报错，逼使用者改用逐行标记或把块拆开。 */
      let covered = 0;
      let j = i + 1;
      for (; j < lines.length && lines[j].trim() !== ''; j++) {
        if (covered >= BLOCK_MAX) {
          missingReason += 1;
          console.error(
            `  ✖ ${rel}:${i + 1}  ignore-block 覆盖超过 ${BLOCK_MAX} 行仍未遇空行——` +
            '范围过大，请改用逐行标记或在块后补空行',
          );
          break;
        }
        exempt.add(j);
        covered += 1;
      }
      return;
    }
    const ml = line.match(IGNORE_LINE);
    if (ml) {
      if (!hasRealReason(ml[1] || ml[2])) {
        missingReason += 1;
        console.error(`  ✖ ${rel}:${i + 1}  ignore-next-line 缺原因说明（需 ≥6 个非标点字符）`);
      }
      exempt.add(i + 1);
    }
  });

  lines.forEach((line, i) => {
    let code = line;
    if (inBlockComment) {
      const end = code.indexOf('*/');
      if (end === -1) return;              // 整行仍在注释里
      code = code.slice(end + 2);
      inBlockComment = false;
    }
    /* 去掉本行内成对的块注释与行尾注释 */
    code = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = code.indexOf('/*');
    if (open !== -1) { code = code.slice(0, open); inBlockComment = true; }
    const line1 = code.indexOf('//');
    if (line1 !== -1) code = code.slice(0, line1);

    /* 豁免判断放在**剥注释之后**：上面那段要先跑完才能正确维护
     * inBlockComment 跨行状态，提前 return 会让状态错位。 */
    if (exempt.has(i)) return;

    const report = (hit) => {
      violations += 1;
      console.error(`  ✖ ${rel}:${i + 1}  ${hit}`);
    };

    for (const hit of code.match(RE) ?? []) report(hit);
    for (const hit of code.match(ARBITRARY_RE) ?? []) report(hit);
    if (isComponent) {
      /* 先挖掉 var(--token, <fallback>) 整体，再找剩下的裸色值 */
      const stripped = code.replace(VAR_FALLBACK_RE, ' ');
      for (const hit of stripped.match(HEX_RE) ?? []) report(hit);
      for (const hit of stripped.match(COLOR_FN_RE) ?? []) report(hit.replace(/\s*\d$/, ''));
    }
  });
}

if (violations > 0 || missingReason > 0) {
  if (violations > 0) {
    console.error(`\n裸调色板色门：${scanned} 个文件中发现 ${violations} 处。`);
    console.error('请改用语义 token（text-text-primary / text-text-secondary /');
    console.error('border-border / bg-surface-elevated / text-primary-text …），');
    console.error('它们随主题切换且已被 lint:contrast 覆盖。');
    console.error('确有例外请在该行上方加：');
    console.error('  // lint-raw-palette-ignore-next-line <原因>');
    console.error('整块声明（如图表系列色）可用 ignore-block，覆盖到下一个空行。');
  }
  if (missingReason > 0) {
    console.error(`\n另有 ${missingReason} 处豁免标记**未写原因**——`);
    console.error('豁免必须说明为什么，否则下一个人无从判断能不能删。');
  }
  process.exit(1);
}
console.log(`✓ 裸调色板色门：${scanned} 个文件，无硬编码调色板色。`);
