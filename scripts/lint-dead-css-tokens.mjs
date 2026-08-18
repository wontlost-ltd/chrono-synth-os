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
const WEB_SRC = join(ROOT, 'apps/web/src');

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

const files = walk(WEB_SRC);

/* 已定义的自定义属性：`--x: value`（含 @theme 块与各主题选择器） */
const defined = new Set();
for (const f of files) {
  for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) {
    defined.add(m[1].toLowerCase());
  }
}

let violations = 0;
for (const f of files) {
  const rel = relative(join(ROOT, 'apps/web'), f);
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/gi)) {
      const name = m[1].toLowerCase();
      if (defined.has(name)) continue;
      violations += 1;
      const fb = m[2]?.trim();
      console.error(
        `  ✖ ${rel}:${i + 1}  ${m[1]} 从未定义` +
        (fb ? `——实际渲染的是 fallback \`${fb}\`（写死，不随主题切换）` : '（且无 fallback，属性会失效）'),
      );
    }
  });
}

if (violations > 0) {
  console.error(`\n死 CSS token 门：发现 ${violations} 处引用了未定义的自定义属性。`);
  console.error('要么在 packages/design-tokens 里补上该 token 并跑 codegen，');
  console.error('要么改用一个已存在的语义 token——不要依赖 fallback 当实际取值。');
  process.exit(1);
}
console.log(`✓ 死 CSS token 门：${files.length} 个文件，${defined.size} 个已定义变量，无悬空引用。`);
