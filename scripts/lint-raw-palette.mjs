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
  /* 图表/可视化系列色：需要固定且**互相可区分**的色相来编码类别，
   * 随主题漂移反而会让「同一状态两次看起来不同」。节点底与文字已改用
   * 语义 token（见文件内注释），此处豁免的只是编码用的系列色。
   * 实测均为装饰性描边/填充，不承载文本。 */
  ['src/pages/WorkforceVisualization.tsx', '组织树的负载/状态/处置编码色，需固定色相区分类别'],
  /* EnterpriseConsole：既有品牌渐变/圆点（装饰，indigo 4.45 / violet 5.03 /
   * cyan 11.01），**也有 trend 徽章的文字色** #22C55E / #F87171——
   * 后者落在卡片(#131B2E)上实测 7.53 / 6.20 过 AA。
   * （早期注释误写成「非文本」，且数字是对着纯黑底算的、没算 tint 合成，已更正。） */
  ['src/pages/EnterpriseConsole.tsx', '品牌渐变/圆点装饰 + trend 徽章文字色，实测 4.45~11.01'],
  /* AdminToolPermissions：SCOPE_STYLE.fg 是**徽章文字色**（非装饰），
   * 底为同色 12~14% rgba 叠在卡片上。按真实合成底色实测：
   * read 9.30 / write 9.30 / execute 8.31，全部过 AA。 */
  ['src/pages/AdminToolPermissions.tsx', '作用域徽章文字色，按真实 tint 合成底实测 8.31~9.30'],
  ['src/components/ui/EmptyState.tsx', '空态插画着色 #818CF8（canvas 6.67 / elevated 5.75）'],
  /* 侧边栏 hover/active 的 indigo 微弱高亮：rgba 低透明度叠加，
   * 属纯装饰层，不承载文本对比度。 */
  ['src/components/layout/Sidebar.tsx', '导航 hover/active 的低透明度 indigo 叠加层，纯装饰'],
  /* 激活 tab 下划线的 indigo 辉光（box-shadow）——纯装饰、2px 高、
   * aria-hidden，不承载文本也不传达状态（状态由 aria-selected 承担）。 */
  ['src/components/ui/Tabs.tsx', '激活 tab 下划线的 indigo 辉光 box-shadow，aria-hidden 纯装饰'],
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

let violations = 0;
let scanned = 0;
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

if (violations > 0) {
  console.error(`\n裸调色板色门：${scanned} 个文件中发现 ${violations} 处。`);
  console.error('请改用语义 token（text-text-primary / text-text-secondary /');
  console.error('border-border / bg-surface-elevated / text-primary-text …），');
  console.error('它们随主题切换且已被 lint:contrast 覆盖。');
  console.error('确有例外请登记到 scripts/lint-raw-palette.mjs 的 ALLOW 并写明原因。');
  process.exit(1);
}
console.log(`✓ 裸调色板色门：${scanned} 个文件，无硬编码调色板色。`);
