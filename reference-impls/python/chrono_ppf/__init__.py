"""
chrono_ppf — third-party Python reference implementation of PPF v1.

Pure-stdlib reader/writer used as the EP-4.1 interop proof: it consumes
the canonical test vectors at ``docs/ppf/v1/test-vectors/`` and demonstrates
that the PPF v1 spec can be implemented without any ChronoSynth-specific
code. The TypeScript implementation in ``packages/contracts`` is the
"insider" implementation; this one is the "outsider" implementation that
proves the spec is unambiguous enough for a foreign ecosystem to read.

设计目标:
    1. 仅依赖 Python 标准库 (json/hashlib/dataclasses), 拒绝任何 npm/zod 衍生品。
    2. 完整覆盖 spec.md §3-§10 的字段与排序约束。
    3. 提供 round-trip API: load → validate → re-serialize → SHA-256 一致。
"""

from .reader import (
    PpfV1Document,
    PpfValidationError,
    load,
    loads,
    validate,
)
from .canonical import canonicalize, document_checksum

__all__ = [
    "PpfV1Document",
    "PpfValidationError",
    "canonicalize",
    "document_checksum",
    "load",
    "loads",
    "validate",
]

__version__ = "0.1.0"
