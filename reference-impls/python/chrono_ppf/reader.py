"""
PPF v1 reader — load + validate.

Implements the §3-§10 schema rules from ``docs/ppf/v1/spec.md``. Errors
surface as :class:`PpfValidationError` with a JSON-pointer-ish ``path``
attribute so test vectors can assert which constraint fired.

This is intentionally hand-rolled (no jsonschema/pydantic) so the
file makes a cleaner "spec-only" reference for other implementers.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

PPF_V1_CONTEXT = "https://chrono-synth.dev/ppf/v1"
PPF_V1_VERSION = "1.0"
PPF_V1_TYPE = "PersonaKernel"
MEMORY_SCHEMA = "memory-node.v1"

_DID_RE = re.compile(r"^did:chrono:[a-z2-7]{8,}$")
_CHECKSUM_RE = re.compile(r"^sha256:0x[0-9a-f]{64}$", re.IGNORECASE)
_BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_MEMORY_KIND = {"fact", "event", "belief", "relationship", "goal"}
_SOURCE_KIND = {"user_input", "system_inferred", "api_sync", "unknown"}
_HALLUC_POLICY = {"block", "flag_and_confirm", "log_only"}


class PpfValidationError(ValueError):
    """Raised when a PPF document fails schema or invariant checks."""

    def __init__(self, message: str, path: Sequence[str | int] = ()) -> None:
        super().__init__(message)
        self.message = message
        self.path = tuple(path)

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        loc = "/".join(str(p) for p in self.path) or "<root>"
        return f"{loc}: {self.message}"


@dataclass(frozen=True)
class PpfV1Document:
    """Parsed, validated PPF v1 document. Holds the raw dict for round-trip."""

    raw: dict
    """Unmodified input document; canonicalize() consumes this directly."""


# ── helpers ──────────────────────────────────────────────────────────────


def _require(cond: bool, msg: str, path: Sequence[str | int]) -> None:
    if not cond:
        raise PpfValidationError(msg, path)


def _check_str(value: Any, path: Sequence[str | int], *, min_len: int = 0, max_len: int | None = None) -> str:
    _require(isinstance(value, str), "must be a string", path)
    if min_len and len(value) < min_len:
        raise PpfValidationError(f"must be at least {min_len} chars", path)
    if max_len is not None and len(value) > max_len:
        raise PpfValidationError(f"must be at most {max_len} chars", path)
    return value


def _check_int(value: Any, path: Sequence[str | int], *, min_value: int | None = None) -> int:
    _require(isinstance(value, int) and not isinstance(value, bool), "must be an integer", path)
    if min_value is not None and value < min_value:
        raise PpfValidationError(f"must be >= {min_value}", path)
    return value


def _check_ratio(value: Any, path: Sequence[str | int]) -> float:
    _require(
        isinstance(value, (int, float)) and not isinstance(value, bool),
        "must be a number",
        path,
    )
    f = float(value)
    _require(0.0 <= f <= 1.0, "must be in [0, 1]", path)
    return f


def _check_strict_keys(doc: Any, allowed: set[str], path: Sequence[str | int]) -> None:
    _require(isinstance(doc, dict), "must be an object", path)
    extra = set(doc.keys()) - allowed
    _require(not extra, f"unexpected keys: {sorted(extra)}", path)


# ── per-section validators ──────────────────────────────────────────────


def _validate_value(v: Any, path: Sequence[str | int]) -> None:
    _check_strict_keys(v, {"id", "label", "weight"}, path)
    _check_str(v["id"], (*path, "id"), min_len=1, max_len=128)
    _check_str(v["label"], (*path, "label"), min_len=1, max_len=256)
    _check_ratio(v["weight"], (*path, "weight"))


def _validate_values(values: Any, path: Sequence[str | int]) -> None:
    _require(isinstance(values, list), "must be an array", path)
    for i, v in enumerate(values):
        _validate_value(v, (*path, i))
    # Spec §4: sorted by (-weight, id)
    for i in range(1, len(values)):
        prev, curr = values[i - 1], values[i]
        if not (
            prev["weight"] > curr["weight"]
            or (prev["weight"] == curr["weight"] and prev["id"] <= curr["id"])
        ):
            raise PpfValidationError(
                "values must be sorted by weight desc, then id asc",
                (*path, i),
            )


def _validate_narrative(n: Any, path: Sequence[str | int]) -> None:
    _check_strict_keys(n, {"primary", "additional"}, path)
    _check_str(n["primary"], (*path, "primary"), min_len=1, max_len=4096)
    additional = n["additional"]
    _require(isinstance(additional, list), "must be an array", (*path, "additional"))
    for i, line in enumerate(additional):
        _check_str(line, (*path, "additional", i), max_len=1024)


def _validate_memory_node(node: Any, path: Sequence[str | int]) -> None:
    allowed = {
        "id", "kind", "summary", "confidenceScore", "unverified",
        "sourceKind", "createdAt", "updatedAt", "tenantScope",
    }
    _check_strict_keys(node, allowed, path)
    _check_str(node["id"], (*path, "id"), min_len=1, max_len=128)
    _require(node["kind"] in _MEMORY_KIND, f"kind must be one of {sorted(_MEMORY_KIND)}", (*path, "kind"))
    _check_str(node["summary"], (*path, "summary"), min_len=1, max_len=1024)
    _check_ratio(node["confidenceScore"], (*path, "confidenceScore"))
    _require(isinstance(node["unverified"], bool), "must be a boolean", (*path, "unverified"))
    _require(node["sourceKind"] in _SOURCE_KIND, f"sourceKind must be one of {sorted(_SOURCE_KIND)}", (*path, "sourceKind"))
    _check_int(node["createdAt"], (*path, "createdAt"), min_value=0)
    _check_int(node["updatedAt"], (*path, "updatedAt"), min_value=0)
    _check_str(node["tenantScope"], (*path, "tenantScope"), min_len=1, max_len=128)


def _validate_memory_edge(edge: Any, path: Sequence[str | int]) -> None:
    _check_strict_keys(edge, {"from", "to", "relation", "weight"}, path)
    _check_str(edge["from"], (*path, "from"), min_len=1, max_len=128)
    _check_str(edge["to"], (*path, "to"), min_len=1, max_len=128)
    _check_str(edge["relation"], (*path, "relation"), min_len=1, max_len=64)
    _check_ratio(edge["weight"], (*path, "weight"))


def _validate_memory(m: Any, path: Sequence[str | int]) -> None:
    _check_strict_keys(m, {"schema", "nodes", "edges"}, path)
    _require(m["schema"] == MEMORY_SCHEMA, f"schema must be {MEMORY_SCHEMA}", (*path, "schema"))
    nodes, edges = m["nodes"], m["edges"]
    _require(isinstance(nodes, list), "must be an array", (*path, "nodes"))
    _require(isinstance(edges, list), "must be an array", (*path, "edges"))
    for i, n in enumerate(nodes):
        _validate_memory_node(n, (*path, "nodes", i))
    # Spec §6: nodes sorted by createdAt asc
    for i in range(1, len(nodes)):
        if nodes[i - 1]["createdAt"] > nodes[i]["createdAt"]:
            raise PpfValidationError(
                "memory.nodes must be sorted by createdAt asc",
                (*path, "nodes", i),
            )
    for i, e in enumerate(edges):
        _validate_memory_edge(e, (*path, "edges", i))


def _validate_tools(t: Any, path: Sequence[str | int]) -> None:
    _check_strict_keys(t, {"allowed", "denied"}, path)
    for key in ("allowed", "denied"):
        arr = t[key]
        _require(isinstance(arr, list), "must be an array", (*path, key))
        for i, name in enumerate(arr):
            _check_str(name, (*path, key, i), min_len=1, max_len=128)


def _validate_governance(g: Any, path: Sequence[str | int]) -> None:
    allowed = {"driftThreshold", "hallucinationPolicy", "retentionDays", "requireConfirmationFor"}
    _check_strict_keys(g, allowed, path)
    drift = g["driftThreshold"]
    _check_strict_keys(drift, {"warning", "critical"}, (*path, "driftThreshold"))
    warning = _check_ratio(drift["warning"], (*path, "driftThreshold", "warning"))
    critical = _check_ratio(drift["critical"], (*path, "driftThreshold", "critical"))
    _require(critical > warning, "critical must be > warning", (*path, "driftThreshold"))
    _require(g["hallucinationPolicy"] in _HALLUC_POLICY, f"must be one of {sorted(_HALLUC_POLICY)}", (*path, "hallucinationPolicy"))
    _check_int(g["retentionDays"], (*path, "retentionDays"), min_value=7)
    rcf = g["requireConfirmationFor"]
    _require(isinstance(rcf, list), "must be an array", (*path, "requireConfirmationFor"))
    for i, name in enumerate(rcf):
        _check_str(name, (*path, "requireConfirmationFor", i), min_len=1, max_len=128)


def _validate_provenance(p: Any, path: Sequence[str | int]) -> None:
    _check_strict_keys(p, {"exportedBy", "exportReason", "checksum"}, path)
    _check_str(p["exportedBy"], (*path, "exportedBy"), min_len=1, max_len=128)
    _check_str(p["exportReason"], (*path, "exportReason"), min_len=1, max_len=256)
    cs = _check_str(p["checksum"], (*path, "checksum"))
    _require(_CHECKSUM_RE.match(cs) is not None, "checksum must match sha256:0x<hex>", (*path, "checksum"))


def _validate_signature(sig: Any, path: Sequence[str | int]) -> None:
    if sig is None:
        return
    _check_strict_keys(sig, {"alg", "keyId", "signedAt", "value"}, path)
    _require(sig["alg"] == "Ed25519", "alg must be Ed25519", (*path, "alg"))
    _check_str(sig["keyId"], (*path, "keyId"), min_len=1, max_len=256)
    _check_int(sig["signedAt"], (*path, "signedAt"), min_value=0)
    val = _check_str(sig["value"], (*path, "value"))
    _require(_BASE64URL_RE.match(val) is not None, "value must be base64url", (*path, "value"))


# ── public API ───────────────────────────────────────────────────────────


def validate(doc: Any) -> PpfV1Document:
    """
    Validate a PPF v1 document. Raises :class:`PpfValidationError` on failure.

    On success returns a :class:`PpfV1Document` wrapping the original dict
    so callers can re-canonicalize without mutation.
    """
    _require(isinstance(doc, dict), "document must be an object", ())
    allowed = {
        "@context", "@type", "id", "version", "createdAt", "exportedAt",
        "sourceInstance", "values", "narrative", "memory", "capabilities",
        "tools", "governance", "provenance", "signature",
    }
    extra = {k for k in doc.keys() if not k.startswith("x-")} - allowed
    _require(not extra, f"unexpected top-level keys: {sorted(extra)}", ())

    _require(doc.get("@context") == PPF_V1_CONTEXT, f"@context must be {PPF_V1_CONTEXT}", ("@context",))
    _require(doc.get("@type") == PPF_V1_TYPE, f"@type must be {PPF_V1_TYPE}", ("@type",))
    _require(doc.get("version") == PPF_V1_VERSION, f"version must be {PPF_V1_VERSION}", ("version",))
    pid = _check_str(doc["id"], ("id",))
    _require(_DID_RE.match(pid) is not None, "id must be did:chrono:<base32>", ("id",))
    _check_int(doc["createdAt"], ("createdAt",), min_value=0)
    _check_int(doc["exportedAt"], ("exportedAt",), min_value=0)
    _check_str(doc["sourceInstance"], ("sourceInstance",), min_len=1, max_len=512)
    _validate_values(doc["values"], ("values",))
    _validate_narrative(doc["narrative"], ("narrative",))
    _validate_memory(doc["memory"], ("memory",))
    capabilities = doc["capabilities"]
    _require(isinstance(capabilities, list), "must be an array", ("capabilities",))
    for i, c in enumerate(capabilities):
        _check_str(c, ("capabilities", i), min_len=1, max_len=64)
    _validate_tools(doc["tools"], ("tools",))
    _validate_governance(doc["governance"], ("governance",))
    _validate_provenance(doc["provenance"], ("provenance",))
    _validate_signature(doc.get("signature"), ("signature",))

    return PpfV1Document(raw=doc)


def loads(text: str) -> PpfV1Document:
    """Parse JSON ``text`` and validate as PPF v1."""
    return validate(json.loads(text))


def load(path: str | Path) -> PpfV1Document:
    """Load and validate a PPF v1 document from ``path``."""
    return loads(Path(path).read_text(encoding="utf-8"))
