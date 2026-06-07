#!/usr/bin/env sh
# i18n 漏网检查 — P0.4
#
# 阻止 UI 源码（src/{pages,components,features,hooks,layout}）出现未提取的
# CJK 统一表意文字（U+4E00–U+9FFF）字面量。注释（JSDoc/行内 //、JSX {/*..*/}）、
# 测试文件、本地化资源 JSON 不在范围内。
#
# 退出码：0 无漏网；1 发现漏网；2 环境错误。
#
# 实现说明：使用 Python 走 Unicode 字符比较，避免 BSD grep 在 LC_ALL=C 下
# 将 multi-byte UTF-8 范围当字节比较的误报问题。

set -eu
exec python3 "$(dirname "$0")/check-i18n.py" "$@"
