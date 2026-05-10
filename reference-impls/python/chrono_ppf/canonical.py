"""
RFC 8785 JSON Canonicalization Scheme (subset) + SHA-256 checksum.

PPF v1 §9 mandates that ``provenance.checksum`` is computed over the
canonical bytes of the document with ``signature`` set to ``null``. This
module implements just enough of RFC 8785 to satisfy that requirement:

- Object keys MUST be sorted lexicographically by their UTF-16 code-unit
  representation. For the field names PPF uses (ASCII-only) this collapses
  to plain Python ``sorted()`` over ``str``.
- Strings use the JSON-defined escape rules; we delegate to ``json.dumps``
  with ``ensure_ascii=False`` so that non-ASCII narratives round-trip
  without ``\\uXXXX`` rewrapping.
- Numbers: PPF uses only ``int`` (millisecond epochs, retentionDays) and
  finite ``float`` in [0, 1] with up to 4 fractional digits. RFC 8785
  number canonicalization for our finite, bounded inputs reduces to
  Python's repr — but ``json.dumps`` already emits ``0.92``-style output,
  so we accept that. The vectors are constructed to avoid edge cases
  (NaN, ±Inf, exponent notation), which the spec also forbids implicitly
  via field type constraints.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonicalize(doc: Any) -> bytes:
    """
    Return the canonical UTF-8 bytes for ``doc``.

    ``doc`` may be any JSON-compatible Python value. Output is suitable
    for hashing; do not rely on it for human inspection.
    """
    return json.dumps(
        doc,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def document_checksum(doc: dict) -> str:
    """
    Compute the spec-§9 checksum for a PPF document.

    The checksum covers the document with ``signature`` set to ``None``,
    independent of whether a signature is present. The producer SHOULD
    emit this value into ``provenance.checksum``; consumers verify by
    re-running this function on the received document.

    Returns the spec-formatted ``sha256:0x<hex>`` string.
    """
    snapshot = dict(doc)
    snapshot["signature"] = None
    digest = hashlib.sha256(canonicalize(snapshot)).hexdigest()
    return f"sha256:0x{digest}"
