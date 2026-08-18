#!/usr/bin/env node
/**
 * 禁止 `var(--token, <fallback>)` 引用**从未定义过**的 CSS 自定义属性。
 *
 * 为什么需要这道门：`var(--x, #fff)` 的 fallback 本意是「token 万一缺失时的
 * 降级」，但如果这个 token **压根没被定义过**，fallback 就不是降级——它**就是
 * 实际渲染出来的颜色**，且写死、不随主题切换。
 *
 * 而这恰好落在既有三道门的缝里：
 *   - `lint:raw-palette` 主动豁免 `var(--token, #fallback)`（假设 token 存在）
 *   - `lint:contrast` 只算 token 对，看不见 CSS 文件里的字面量
 *   - axe 只在被纳入路由清单、且元素默认渲染时才可能撞见
 *
 * 实例（本门首次运行即抓到，均已修）：
 *   --color-surface-subtle → 浅灰 #f3f4f6 面板嵌在 dark 卡片里，
 *     实测 DOM 渲染 rgb(243,244,246)；
 *   --color-on-primary → 白字，dark 下侥幸达标(4.94)，
 *     但 light 主题继承色压深底仅 1.72，近乎不可读。
 *
 * 同时检查 Tailwind 的 `text-*`/`bg-*` 语义类是否对应真实变量——
 * `text-on-primary` 这类写法不会报错，只是**静默不生成任何 CSS**。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * 逐个 app **独立**扫描——codegen 把 token 直接写进各 app 自己的 src/
 * （`apps/web/src/styles/themes.css`、`apps/companion-web/src/styles/tokens.css`
 * 等），每个 app 自包含，故不能把定义合并成一个全局集合，否则
 * A 应用定义的变量会掩盖 B 应用里的悬空引用。
 */
const APPS = ['apps/web', 'apps/companion-web', 'apps/desktop'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue; // 断链符号等——与 lint-raw-palette 同样 fail-safe
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(css|tsx?)$/.test(name)) out.push(p);
  }
  return out;
}

let violations = 0;
let totalFiles = 0;
let totalDefined = 0;

for (const app of APPS) {
  const src = join(ROOT, app, 'src');
  let files;
  try {
    files = walk(src);
  } catch {
    continue; // 该 app 不存在或无 src/
  }
  totalFiles += files.length;

  /**
   * 收集「已定义」的自定义属性。三种写法都算定义：
   *   1. CSS 声明 `--x: value`（含 @theme 块、:root[data-theme=…] 各主题选择器）
   *   2. React 内联 / CSS-in-JS 对象 `{ '--x': v }`——常见的动态变量写法
   *      （如进度条 `style={{'--pct': `${n}%`}}`）
   *   3. 命令式 `el.style.setProperty('--x', v)`
   * 后两种不认的话会把合法写法误报成悬空引用。
   *
   * ⚠️ CSS 自定义属性**大小写敏感**（`--Foo` ≠ `--foo`），故全程保留原样比较，
   * 不做 toLowerCase——否则 `--Foo` 的定义会被误当成 `--foo` 的定义而漏报。
   */
  const defined = new Set();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    /* 行首/`{`/`;` 之后的声明——不锚在行首，否则
     * `:root { --a: 1px; --b: 2px; }` 这种同行多定义只认得第一个。 */
    for (const m of text.matchAll(/(?:^|[{;])\s*(--[A-Za-z0-9_-]+)\s*:/gm)) defined.add(m[1]);
    for (const m of text.matchAll(/['"](--[A-Za-z0-9_-]+)['"]\s*:/g)) defined.add(m[1]);
    for (const m of text.matchAll(/setProperty\(\s*['"](--[A-Za-z0-9_-]+)['"]/g)) defined.add(m[1]);
  }
  totalDefined += defined.size;

  for (const f of files) {
    const rel = relative(join(ROOT, app), f);
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)/g)) {
        const name = m[1];
        if (defined.has(name)) continue;
        violations += 1;
        const fb = m[2]?.trim();
        console.error(
          `  ✖ ${app}/${rel}:${i + 1}  ${name} 从未定义` +
          (fb ? `——实际渲染的是 fallback \`${fb}\`（写死，不随主题切换）` : '（且无 fallback，属性会失效）'),
        );
      }
    });
  }
}

if (violations > 0) {
  console.error(`\n死 CSS token 门：发现 ${violations} 处引用了未定义的自定义属性。`);
  console.error('要么在 packages/design-tokens 里补上该 token 并跑 codegen，');
  console.error('要么改用一个已存在的语义 token——不要依赖 fallback 当实际取值。');
  process.exit(1);
}
console.log(`✓ 死 CSS token 门：${APPS.length} 个 app / ${totalFiles} 个文件 / ${totalDefined} 个已定义变量，无悬空引用。`);
