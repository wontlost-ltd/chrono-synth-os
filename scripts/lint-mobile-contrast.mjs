#!/usr/bin/env node
/**
 * apps/mobile 的色彩对比度门。
 *
 * 为什么单独写一个：现有三道门都够不着 mobile——
 *   - `lint:raw-palette` 按 **Tailwind 类名**匹配，RN 用 StyleSheet 对象，没有类名
 *   - `lint:contrast` 按 **语义 token 对**计算，mobile 没有 token 体系
 *   - axe E2E 只跑 web
 * 结果是 mobile 的 190 处硬编码 hex **零门覆盖**。
 *
 * 做法：解析 StyleSheet 里同时带 `fontSize` 与 `color` 的样式条目，
 * 与「该样式自身的 backgroundColor → 同文件容器底 → 屏幕默认底」逐级回退
 * 求出的底色比对，按 WCAG 判 AA（≥18px 用 3.0，否则 4.5）。
 *
 * ⚠️ 已知局限：无法跟踪「文字在 A 组件、底色在 B 组件」的跨组件组合
 * （如按钮文字样式与按钮容器样式分开定义）。这类需人工确认，
 * 故支持 `// lint-mobile-contrast-ignore-next-line <原因>` 行级豁免。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGET = join(ROOT, 'apps/mobile/src');

/** RN 无主题切换，屏幕默认底色（多数 container 用 #F8FAFC）。 */
const DEFAULT_BG = '#F8FAFC';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * 把 3/4/6/8 位 hex 归一化成 6 位 RGB（审计 #418）。
 *
 * ⚠️ 必须先展开再算亮度：`lum()` 原先按固定 6 位切片，喂 `#fff` 会得到
 * `parseInt('ff'), parseInt('')` → **NaN**，比率算出来是 NaN、比较恒假 ⇒
 * 静默放行。放宽正则却不改这里，等于把漏检换成假绿。
 */
const normalizeHex = (hex) => {
  const h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) {
    /* #rgb / #rgba → 每位翻倍；alpha 位丢弃（对比度只看 RGB）。 */
    return h.slice(0, 3).split('').map((c) => c + c).join('');
  }
  /* #rrggbbaa → 丢弃 alpha。 */
  return h.slice(0, 6);
};

const lum = (hex) => {
  const h = normalizeHex(hex);
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return +((x + 0.05) / (y + 0.05)).toFixed(2);
};

let violations = 0;
let checked = 0;
for (const file of walk(TARGET)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(join(ROOT, 'apps/mobile'), file);
  const lines = text.split('\n');

  /* 行级豁免 */
  const exempt = new Set();
  lines.forEach((l, i) => {
    const m = l.match(/lint-mobile-contrast-ignore-next-line\b(.*)$/);
    if (m) {
      if (m[1].replace(/[\s\p{P}\p{S}*/]/gu, '').length < 6) {
        violations += 1;
        console.error(`  ✖ ${rel}:${i + 1}  豁免标记缺原因说明（需 ≥6 个非标点字符）`);
      }
      /* `i` 是 0-based 行下标，故 `i + 1` 是**标记自身**的 1-based 行号；
       * 要豁免的是它下面那一行（或那一行起始的样式块），所以是 `i + 2`。 */
      exempt.add(i + 2);
    }
  });

  /* 该文件的根容器底色。根样式命名不统一——实测有 `container` 也有 `screen`
   * （ConflictInboxScreen 用后者，且它是全仓唯一的暗色屏 #0F172A）。
   * 只认 `container` 会让暗色屏回退到浅色默认底，把该屏所有文字误判成不达标。 */
  const cm = text.match(/(?:container|screen|root|wrapper):\s*\{[^}]*backgroundColor:\s*'(#[0-9a-fA-F]{6})'/s);
  const fileBg = cm ? cm[1] : DEFAULT_BG;

/**
 * 枚举样式项的花括号块，返回 `{ 0: 块文本, index: 起始下标 }`（与 matchAll 同形状）。
 *
 * ⚠️ 审计 #439：原实现是 `text.matchAll(/\{[^{}]*\}/gs)`。`[^{}]` 决定它
 * **只能匹配最内层**花括号，于是任何含嵌套 `{}` 的样式项整条从检查里消失——
 * 而 `shadowOffset: { width: 0, height: 1 }` 和 `transform: [{ scale: 1.1 }]`
 * 都是 RN 的惯用写法。
 *
 * 实测（同一个必不达标的 `color: '#F1F5F9'`，1.05 对比度）：
 *   - 无嵌套 → 报违规，checked 75→76
 *   - 加 shadowOffset → 「全部达标」，checked 回到 75
 *   - 加 transform   → 「全部达标」，checked 回到 75
 * 注意 checked **分母**也跟着缩水——门不会以任何形式提示「我跳过了一条」，
 * 这正是它比漏报更危险的地方：绿勾看起来覆盖了 75 处，实际分母是虚的。
 *
 * 改为花括号配平扫描：从每个 `{` 出发找到配平的 `}`，块内允许任意层嵌套。
 * 为保持「按样式项」的粒度（而非把整个 StyleSheet.create 当一块），
 * 只收**深度 1 的直接子块**——即样式项本身，其内部的 shadowOffset 等
 * 嵌套对象作为文本留在块里参与 fontSize/color 匹配。
 *
 * 不上 AST：为一个 155 行的门引入 parser 依赖，复杂度与问题严重度不匹配。
 * 字符串里的花括号理论上会干扰配平，但 RN 样式值是颜色/数字/枚举字符串，
 * 实测全仓无一例含花括号的样式字符串（回归判据：既有 75 处结论不变）。
 */
function styleBlocks(text) {
  const out = [];
  let depth = 0;
  /** 深度→该层最近一个 `{` 的下标 */
  const opens = [];
  /** 深度→该层在闭合前是否出现过子块（用于识别「样式项」这一层） */
  const hadChild = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth > 0) hadChild[depth - 1] = true;
      opens[depth] = i;
      hadChild[depth] = false;
      depth += 1;
      continue;
    }
    if (ch !== '}') continue;
    depth -= 1;
    if (depth < 0) { depth = 0; continue; }   // 花括号不配平（模板字符串等）→ 容错
    const start = opens[depth];
    if (start === undefined) continue;
    const block = text.slice(start, i + 1);
    /* 只收**样式项**这一层：它自己带 fontSize/color 这类叶子属性。
     *
     * ⚠️ 不能无条件收所有配平块——那会把外层容器 `{ container: {…}, ok: {…} }`
     * 也当成一条样式，于是 `ok` 的 fontSize/color 会跟 `container` 的
     * backgroundColor 凑成一条假记录（实测打破了「样式块自带 backgroundColor
     * → 以它为底判定」这条既有用例）。
     *
     * 判据：块内**直接**出现 fontSize 才算样式项。外层容器的 fontSize 只
     * 存在于其子块里，而样式项自己的嵌套子块（shadowOffset / transform）
     * 不含 fontSize，故两者可分。 */
    if (/fontSize:\s*\d+/.test(stripNested(block))) {
      out.push({ 0: block, index: start });
    }
  }
  return out;
}

/** 去掉块内的嵌套子块，只留本层的直接属性文本。 */
function stripNested(block) {
  let out = '';
  let depth = 0;
  for (let i = 1; i < block.length - 1; i++) {
    const ch = block[i];
    if (ch === '{' || ch === '[') { depth += 1; continue; }
    if (ch === '}' || ch === ']') { depth -= 1; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

  /* 按**样式块**（最内层 `{ … }`）解析，而不是按行——RN 的 StyleSheet 既有
   * 单行写法 `meta: { fontSize: 12, color: '#94A3B8' }`，也有跨行写法：
   *     meta: {
   *       fontSize: 12,
   *       color: '#94A3B8',
   *     }
   * 只按行匹配会**静默漏掉后者**（本仓实测 15 处），漏报比误报更危险。 */
  for (const m of styleBlocks(text)) {
    const block = m[0];
    const size = block.match(/fontSize:\s*(\d+)/);
    /* 排除非文本色属性：backgroundColor / borderColor / tintColor /
     * shadowColor / placeholderTextColor 都不是正文前景色。 */
    /* ⚠️ 审计 #418：原先写死「单引号 + 恰好 6 位 hex」，于是 3 位/4 位/8 位 hex、
     * **双引号**、`rgb()` 全部逃逸 —— 生产实例 `ConflictInboxScreen.tsx:243` 的
     * `actionBtnText: { color: '#fff', fontSize: 13 }` 是真实正文样式，
     * 门**从未评估过它**（等价改写 '#fff'→'#ffffff' 后计数 74→75，可见覆盖数一直是虚的）。
     * RN 无类名无 token，这道门是移动端唯一防线。 */
    const color = block.match(/(?<!background)(?<!border)(?<!tint)(?<!shadow)(?<!placeholderText)[Cc]olor:\s*['"](#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))['"]/);
    if (!size || !color) continue;

    const lineNo = text.slice(0, m.index).split('\n').length;
    const endLine = lineNo + block.split('\n').length - 1;
    /* 豁免写在块内任意一行上方均生效 */
    let skipped = false;
    for (let ln = lineNo; ln <= endLine; ln += 1) {
      if (exempt.has(ln)) { skipped = true; break; }
    }
    if (skipped) continue;

    /* 样式块自带 backgroundColor 时以它为底 */
    const ownBg = block.match(/backgroundColor:\s*'(#[0-9a-fA-F]{6})'/);
    const bg = ownBg ? ownBg[1] : fileBg;
    const need = +size[1] >= 18 ? 3.0 : 4.5;
    const c = ratio(color[1], bg);
    checked += 1;
    if (c < need) {
      violations += 1;
      console.error(
        `  ✖ ${rel}:${lineNo}  ${color[1]} on ${bg} @${size[1]}px = ${c}（需 ${need}）`,
      );
    }
  }
}

if (violations > 0) {
  console.error(`\nmobile 对比度门：${checked} 处带字号的文本色中发现 ${violations} 处问题。`);
  console.error('若该文字实际落在别的容器底上（跨组件组合，本门跟不到），');
  console.error('请在该行上方加 `// lint-mobile-contrast-ignore-next-line <原因>` 并写明真实底色与实测值。');
  process.exit(1);
}
/* 显式声明分母与跳过原因——只报 checked 会制造虚假安全感：
 * 无 fontSize 的文本样式、JSX 的 color= prop、borderColor 的 1.4.11
 * 非文本对比度，本门都看不到。 */
console.log(`✓ mobile 对比度门：${checked} 处「同时带 fontSize 与 color」的样式全部达标。`);
console.log('  未覆盖：无 fontSize 的文本样式 / JSX color= prop / borderColor 的非文本对比度 / 跨组件底色组合（后者靠行级豁免人工标注）。');
