#!/usr/bin/env python3
"""i18n 漏网检查 — P0.4

扫描 UI 源码目录，找出未提取的 CJK 字面量。
忽略：JSDoc / 行内 // 注释 / JSX {/* ... */} 注释 / 测试文件 / 本地化 JSON。

退出码：
  0  无漏网
  1  发现漏网
  2  环境错误
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 扫描目录与单文件入口
SCAN_PATHS = [
    "src/pages",
    "src/components",
    "src/features",
    "src/hooks",
    "src/layout",
    "src/App.tsx",
]

# 仅检查 .ts / .tsx
EXTS = {".ts", ".tsx"}

# CJK Unified Ideographs (U+4E00–U+9FFF)
CJK_RE = re.compile(r"[一-鿿]")

# Pragma：行尾 `// i18n-allow-cjk: <reason>` 表示该行 CJK 是有意为之
# (语言自显名 / 写入 DB 的种子数据 / 后端协议字符串匹配 等)
PRAGMA_RE = re.compile(r"//\s*i18n-allow-cjk\b")


# 扫描器状态：仅块注释与反引号模板可跨行（单/双引号串内裸换行是语法错误，不结转）。
#   in_block    是否处于 /* ... */（含 JSX {/* ... */}）块注释内
#   stack       模板上下文栈，逐层表达「模板正文 ↔ ${...} 插值」交替嵌套：
#               每元素是一个 int = 该层插值已进入的未配对 `{` 深度；约定：
#                 - push 一个 "TPL" 标记（值 -1）表示进入一段模板正文（反引号正文）
#                 - 模板正文里遇 ${ 时把栈顶 TPL 之上再 push 0（进入插值，brace depth=0）
#               实际实现用两种标记：TPL=-1 表示模板正文层；>=0 表示插值层且记录花括号深度。
#               空栈 = 顶层代码区。栈顶决定当前扫描模式。
TPL = -1  # 栈中表示「模板正文」层的哨兵
ScanState = tuple[bool, tuple[int, ...]]
INITIAL_STATE: ScanState = (False, ())

# 正则字面量 `/` 起始判定：当 `/` 出现在「表达式起始位」时是 regex，否则是除号。
# 表达式起始位 = 上一个有意义字符是运算符/标点/关键字（不是值结尾）。
# 关键取舍（用户铁律：漏报不可接受、误报可接受）——本判定刻意「偏向认作 regex」：
#   · 误判除号为 regex：_consume_regex 只「保留」文本不删除，CJK 仍会被扫到 → 安全（至多误报）。
#   · 误判 regex 为除号：regex 内的 // 触发行注释 → 吞掉同行后续真实 CJK → 漏报（必须避免）。
# 故 prev 集合宁可放宽：含 `)` `]` `}`（覆盖 `if(x) /re/.test()`、`]/re/`、`}/re/` 等合法语句位），
# 关键字含 throw/default 等所有可后接表达式者（Codex 第5轮补全）。
_REGEX_PREV_PUNCT = set("([{,;:=!&|?+-*%~^<>)]}")
_REGEX_PREV_KEYWORDS = ("return", "typeof", "instanceof", "in", "of", "new",
                        "delete", "void", "do", "else", "yield", "await", "case",
                        "throw", "default")


def _prev_significant(out: list[str]) -> str:
    """返回 out 中最后一个非空白字符（用于 regex/除号判定）；空则返回 ''。"""
    for ch in reversed(out):
        if not ch.isspace():
            return ch
    return ""


def _starts_regex(out: list[str]) -> bool:
    """据已输出代码判断当前 `/` 是否为正则字面量起始（表达式位）。偏向认作 regex（见上注释）。"""
    prev = _prev_significant(out)
    if prev == "":
        return True  # 行首/段首：表达式位
    if prev in _REGEX_PREV_PUNCT:
        return True
    # 关键字后（如 `return /re/`、`throw /re/`）：检查 out 尾部单词。
    tail = "".join(out).rstrip()
    word = re.search(r"([A-Za-z_$][\w$]*)$", tail)
    return bool(word and word.group(1) in _REGEX_PREV_KEYWORDS)


def _consume_regex(line: str, i: int, n: int, out: list[str]) -> int:
    """从 `/` 起消费一个正则字面量（原样保留内容），返回闭合 `/` 之后的位置。
    处理 `\\` 转义与 `[...]` 字符类（类内的 `/` 不闭合 regex）。未闭合则消费到行尾。"""
    out.append(line[i]); i += 1  # 起始 /
    in_class = False
    while i < n:
        ch = line[i]
        out.append(ch)
        if ch == "\\" and i + 1 < n:
            out.append(line[i + 1]); i += 2; continue
        if ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        elif ch == "/" and not in_class:
            return i + 1  # 闭合
        i += 1
    return i  # 行尾仍未闭合（保守：内容已原样保留，不触发注释）


def strip_comments(line: str, state: ScanState) -> tuple[str, ScanState, bool]:
    """逐字符扫描一行，剔除注释片段、保留代码与字符串字面量内容，
    返回 (剩余文本, 行末状态, 本行是否含真实代码区 pragma 行注释)。

    为什么需要逐字符 scanner + 模板栈而非正则：
      - 块注释 `/* ... */`（含 JSX `{/* ... */}`）可跨行，也可在行内闭合后再接代码或再开新块；
        整行跳过会漏掉 `*/` 之后同行的真实 CJK 代码（Codex finding 1）。
      - 字符串/模板内的 `/*`、`*/`、`//` 不是注释，裸 rfind/count 会误判并吞掉后续 CJK（finding 2/3）。
      - 反引号模板可合法跨行，其 `${...}` 插值是真实代码，插值里又可再嵌模板（finding 4 及其嵌套形态）；
        「模板正文 ↔ 插值代码」是任意深度交替嵌套，扁平 bool/计数无法表达，必须用模式栈。
      - pragma `// i18n-allow-cjk` 只能在**真实代码区行注释**里生效；若对 raw line 做正则，
        字符串/模板/regex 里出现该文本会误豁免整行 → 漏报（Codex finding 6）。故由本扫描器
        在确认 `//` 处于代码区时，才据其后内容判定 pragma。
    保守原则：不追求完整 TS 解析（正则字面量、JSX 文本等极端情形宁可保留不误删）；
    单/双引号串内容原样保留以便检测其中 CJK 字面量（这正是 i18n 要抓的对象）。
    """
    in_block, stack_t = state
    stack = list(stack_t)          # 模板上下文栈：TPL=模板正文层，>=0=插值层(花括号深度)
    out: list[str] = []
    pragma = False                 # 本行是否在代码区行注释里出现 i18n-allow-cjk
    i, n = 0, len(line)
    quote: str | None = None       # 单/双引号字符串（仅行内有效，不跨行结转）
    while i < n:
        ch = line[i]
        two = line[i:i + 2]
        # —— 块注释内：只找 */，闭合后继续扫描该行剩余 ——
        if in_block:
            if two == "*/":
                in_block = False; i += 2
            else:
                i += 1
            continue
        # —— 单/双引号字符串内：原样保留（含其中 CJK），处理转义，遇同种引号结束 ——
        if quote is not None:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(line[i + 1]); i += 2; continue
            if ch == quote:
                quote = None
            i += 1
            continue
        # —— 模板正文内（栈顶为 TPL）：原样保留；遇 ` 出模板、遇 ${ 进插值 ——
        if stack and stack[-1] == TPL:
            if ch == "\\" and i + 1 < n:
                out.append(two); i += 2; continue
            if ch == "`":
                stack.pop(); out.append(ch); i += 1; continue
            if two == "${":
                stack.append(0); out.append(two); i += 2; continue
            out.append(ch); i += 1; continue
        # —— 代码区（顶层代码 或 ${...} 插值内部，栈顶为 >=0 的花括号深度）——
        if ch in ("'", '"'):
            quote = ch; out.append(ch); i += 1; continue
        if ch == "`":
            stack.append(TPL); out.append(ch); i += 1; continue
        # 正则字面量优先于注释判定：表达式位的 `/.../ ` 里的 `//`、`/*` 不是注释，
        # 否则会把同行后续真实 CJK 误吞（Codex 第4轮 finding）。注意 `/*` 起始仍是块注释——
        # 正则首字符不可能是 `*`，故 regex 分支显式排除 `//`、`/*` 两种形态。
        if ch == "/" and two not in ("//", "/*") and _starts_regex(out):
            i = _consume_regex(line, i, n, out); continue
        if two == "//":
            # 真实代码区行注释：丢弃本行剩余；若注释内含 pragma 则标记本行豁免。
            if PRAGMA_RE.search(line[i:]):
                pragma = True
            break
        if two == "/*":
            in_block = True; i += 2; continue
        if stack and ch == "{":
            stack[-1] += 1; out.append(ch); i += 1; continue
        if stack and ch == "}":
            if stack[-1] == 0:
                stack.pop()        # 退出插值，回到外层模板正文
            else:
                stack[-1] -= 1
            out.append(ch); i += 1; continue
        out.append(ch); i += 1
    return "".join(out), (in_block, tuple(stack)), pragma


def iter_files(paths):
    for p in paths:
        full = ROOT / p
        if not full.exists():
            continue
        if full.is_file():
            if full.suffix in EXTS and ".test." not in full.name:
                yield full
            continue
        for sub in full.rglob("*"):
            if sub.is_file() and sub.suffix in EXTS and ".test." not in sub.name:
                yield sub


def scan_text(text: str) -> list[tuple[int, str]]:
    """扫描整段源码文本，返回剔除注释/豁免后仍含 CJK 的 (行号, 原始行) 列表。
    块注释与反引号模板状态逐行结转，正确处理跨行块、`*/` 后同行代码、字符串/模板内的 `/*`、
    跨行模板与其 `${...}` 插值、正则字面量、pragma 位置等边界（Codex 交叉审查的全部发现）。"""
    hits: list[tuple[int, str]] = []
    state = INITIAL_STATE  # (in_block, stack) 逐行结转
    for lineno, raw in enumerate(text.splitlines(), 1):
        stripped, state, pragma = strip_comments(raw, state)
        # pragma 仅在「真实代码区行注释」里生效（由 scanner 判定，非对 raw line 做正则——
        # 否则字符串/模板里出现该文本会误豁免整行 → 漏报）。
        if pragma:
            continue
        if CJK_RE.search(stripped):
            hits.append((lineno, raw))
    return hits


def self_test() -> int:
    """内置边界回归（无需外部测试框架）：覆盖 Codex 交叉审查指出的 4 个漏报/误报 + 原多行注释豁免。
    通过 `python3 scripts/check-i18n.py --self-test` 运行。"""
    cases = [
        ("blockClose-then-code", '/*\n * x\n */ const label = "中文";\n', {3}),
        ("string-slashstar-not-block", 'const m = "a/*b";\nconst t = "中文";\n', {2}),
        ("inline-jsx-comment-then-code", '{/* note */}<span>中文</span>\n', {1}),
        ("multiline-jsx-comment-exempt", '<div>\n  {/* 第一行\n      第二行 */}\n  <span>x</span>\n</div>\n', set()),
        ("plain-code-cjk-caught", 'const t = "真实文本";\n', {1}),
        ("trailing-line-comment-exempt", 'const x = 1; // 这是注释\n', set()),
        ("slashslash-in-string-not-comment", 'const u = "http://例子";\n', {1}),
        # finding 4：多行模板正文像注释 → 不得当注释吞掉（模板正文是真实字符串）。
        ("template-slashslash-not-comment", 'const m = `\n// 中文\n`;\n', {2}),
        ("template-slashstar-not-comment", 'const m = `\n/* 中文 */\n`;\n', {2}),
        # 模板插值内是真实代码：其中的真实 CJK 标识应被抓。
        ("template-interp-code-cjk", 'const m = `${ 中文变量 }`;\n', {1}),
        # 模板插值内的真实注释应豁免（按代码扫描）。
        ("template-interp-comment-exempt", 'const m = `${/* 中文 */ value}`;\n', set()),
        # 模板正文本身的 CJK 文案应被抓（i18n 正是要抓这类）。
        ("template-body-cjk-caught", 'const m = `你好 ${x}`;\n', {1}),
        # 嵌套：插值里再嵌模板，其正文像注释 → 仍是模板正文不得当注释吞掉（Codex 第3轮 finding）。
        ("nested-template-slashslash", 'const m = `${ fn(`\n// 中文\n`) }`;\n', {2}),
        ("nested-template-slashstar", 'const m = `${ fn(`\n/* 中文 */\n`) }`;\n', {2}),
        # 插值内含嵌套花括号（对象/调用）后仍能正确回到模板正文，模板尾部 CJK 文案被抓。
        ("interp-nested-braces-then-body-cjk", 'const m = `${ f({a: 1}) }尾部中文`;\n', {1}),
        # 插值内嵌套花括号里的真实注释应豁免。
        ("interp-nested-braces-comment-exempt", 'const m = `${ f({a: 1}) /* 中文 */ }`;\n', set()),
        # 正则字面量里的 // 不是行注释 → 同行后续真实 CJK 仍被抓（Codex 第4轮 finding）。
        ("regex-slashslash-then-cjk", 'const re = /https?:\\/\\//; const label = "中文";\n', {1}),
        # 正则字符类 [...] 内的 / 不闭合 regex；其后真实 CJK 仍被抓。
        ("regex-charclass-then-cjk", 'const re = /[a-z/]+/; const t = "中文";\n', {1}),
        # 真正的行注释仍要豁免（不能因为加了 regex 分支而误判 // 为 regex）。
        ("real-line-comment-still-exempt", 'const x = 1; // 中文注释\n', set()),
        # 除号场景：值后的 / 是除号不是 regex，后续 // 仍是行注释（豁免）。
        ("division-then-line-comment", 'const y = a / b; // 中文\n', set()),
        # Codex 第5轮补漏：这些合法表达式位的 regex，其内 // 不得吞后续真实 CJK。
        ("regex-after-paren-stmt", 'if (ok) /https?:\\/\\//.test(url); const l = "中文";\n', {1}),
        ("regex-after-throw", 'function f(){ throw /a\\/\\/b/; } const l = "中文";\n', {1}),
        ("regex-after-default", 'export default /a\\/\\/b/; const l = "中文";\n', {1}),
        # pragma 仅真实代码区行注释生效：字符串/模板里出现该文本不得豁免整行（Codex 第6轮 finding）。
        ("pragma-text-in-string-not-exempt", 'const label = "中文"; const m = "// i18n-allow-cjk";\n', {1}),
        ("pragma-text-in-template-not-exempt", 'const label = `中文 // i18n-allow-cjk`;\n', {1}),
        # 真实 pragma 仍应豁免（有意为之的 CJK，如语言自显名）。
        ("real-pragma-exempt", 'const lang = "中文"; // i18n-allow-cjk: language self-name\n', set()),
    ]
    ok = True
    for name, src, expected in cases:
        got = {ln for ln, _ in scan_text(src)}
        passed = got == expected
        ok &= passed
        print(f"  {'✓' if passed else '✗'} {name}: expected {sorted(expected)}, got {sorted(got)}")
    print("self-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    # 健壮性：路径下任何文件不可读应当报错而非静默
    violations: list[tuple[Path, int, str]] = []
    file_count = 0

    for f in iter_files(SCAN_PATHS):
        file_count += 1
        try:
            text = f.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            print(f"check-i18n: cannot decode {f} as utf-8", file=sys.stderr)
            return 2
        for lineno, raw in scan_text(text):
            violations.append((f.relative_to(ROOT), lineno, raw))

    if not violations:
        print(f"✓ check-i18n: scanned {file_count} files, no untranslated CJK literals")
        return 0

    print(f"✗ check-i18n: found {len(violations)} untranslated CJK literal(s) in {file_count} files:\n")
    for path, lineno, raw in violations:
        # 截断超长行
        snippet = raw if len(raw) <= 160 else raw[:157] + "..."
        print(f"  {path}:{lineno}: {snippet}")
    print()
    print("Fix:")
    print("  - Move UI strings into src/i18n/locales/{zh-CN,en-US}.json and use t().")
    print("  - If the literal is intentional data (e.g. seed values written to DB),")
    print("    move it out of src/{pages,components,features}/ into a data module.")
    print("  - Test files (*.test.{ts,tsx}) are auto-excluded.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
