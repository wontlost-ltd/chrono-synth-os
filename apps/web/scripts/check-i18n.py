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

# 注释行识别（剔除注释中的 CJK，但保留代码中的）
# 1) 整行 JSDoc/* * / 或 //
LINE_COMMENT_RE = re.compile(r"^\s*(\*/?|//|/\*)")
# 2) JSX 注释 {/* ... */}（一行内闭合）
JSX_COMMENT_RE = re.compile(r"\{\s*/\*.*?\*/\s*\}")

# Pragma：行尾 `// i18n-allow-cjk: <reason>` 表示该行 CJK 是有意为之
# (语言自显名 / 写入 DB 的种子数据 / 后端协议字符串匹配 等)
PRAGMA_RE = re.compile(r"//\s*i18n-allow-cjk\b")


def strip_comments(line: str) -> str:
    """剔除可识别的注释片段，返回剩余代码部分。"""
    if LINE_COMMENT_RE.match(line):
        return ""
    # 剔除 JSX {/* ... */}
    line = JSX_COMMENT_RE.sub("", line)
    # 剔除行尾 // 注释（保守：不识别字符串内的 //）
    if "//" in line:
        idx = line.find("//")
        # 简化：若 // 之前没有未闭合引号，认为是注释
        before = line[:idx]
        if before.count("'") % 2 == 0 and before.count('"') % 2 == 0 and before.count("`") % 2 == 0:
            line = before
    return line


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


def main() -> int:
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
        for lineno, raw in enumerate(text.splitlines(), 1):
            if PRAGMA_RE.search(raw):
                continue  # 行级 pragma 豁免
            stripped = strip_comments(raw)
            if CJK_RE.search(stripped):
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
