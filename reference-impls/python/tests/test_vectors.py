"""
Round-trip the canonical PPF v1 test vectors with the third-party
Python reference implementation.

This is the EP-4.1 interop proof: the same vectors that
``src/test/contract/ppf-v1-test-vectors.test.ts`` runs against the
TypeScript zod schema must also be readable / rejectable by an
implementation written in a different language with no shared code.

Run with ``python -m unittest`` from this directory, or via the script
at ``reference-impls/python/run_tests.sh``.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

# Add parent dir so ``import chrono_ppf`` works without an install step.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from chrono_ppf import (  # noqa: E402  (import-after-path-edit is intentional)
    PpfValidationError,
    canonicalize,
    document_checksum,
    loads,
    validate,
)

VECTOR_DIR = HERE.parent.parent.parent / "docs" / "ppf" / "v1" / "test-vectors"

MUST_PARSE = ["minimal-valid.json"]
MUST_REJECT = ["invalid-values-out-of-order.json"]

# Pinned cross-impl hash (EP-4.1). The TypeScript canonicalizer in
# packages/contracts/src/ppf/v1.ts is asserted against the same value;
# both implementations failing in lockstep is the proof that the spec is
# unambiguous. If you intentionally change the canonical form, update
# this constant *and* the matching constant in the TS test file in the
# same commit.
MINIMAL_VALID_CHECKSUM = (
    "sha256:0x082d2793c3d6366750be45fb0fea7f4129836743cb8bbe9ed813064d967da680"
)


class PpfV1Vectors(unittest.TestCase):
    def test_vector_dir_resolved(self) -> None:
        self.assertTrue(
            VECTOR_DIR.is_dir(),
            f"vector dir not found at {VECTOR_DIR}; layout has shifted",
        )

    def test_must_parse(self) -> None:
        for name in MUST_PARSE:
            with self.subTest(vector=name):
                doc = (VECTOR_DIR / name).read_text(encoding="utf-8")
                # Must not raise.
                validated = loads(doc)
                self.assertIsNotNone(validated.raw)

    def test_must_reject(self) -> None:
        for name in MUST_REJECT:
            with self.subTest(vector=name):
                doc = (VECTOR_DIR / name).read_text(encoding="utf-8")
                with self.assertRaises(PpfValidationError):
                    loads(doc)

    def test_round_trip_canonical_bytes_stable(self) -> None:
        """
        Canonicalizing the same document twice MUST produce identical bytes.
        This is the precondition for the §9 checksum to be meaningful.
        """
        doc = json.loads((VECTOR_DIR / "minimal-valid.json").read_text(encoding="utf-8"))
        first = canonicalize(doc)
        second = canonicalize(json.loads(first.decode("utf-8")))
        self.assertEqual(first, second)

    def test_checksum_matches_self(self) -> None:
        """document_checksum() must be deterministic."""
        doc = json.loads((VECTOR_DIR / "minimal-valid.json").read_text(encoding="utf-8"))
        a = document_checksum(doc)
        b = document_checksum(doc)
        self.assertEqual(a, b)
        self.assertRegex(a, r"^sha256:0x[0-9a-f]{64}$")

    def test_checksum_matches_typescript_pin(self) -> None:
        """
        Cross-impl interop: this hash is also asserted in the TS test at
        src/test/contract/ppf-v1-test-vectors.test.ts. Both must match.
        """
        doc = json.loads((VECTOR_DIR / "minimal-valid.json").read_text(encoding="utf-8"))
        self.assertEqual(document_checksum(doc), MINIMAL_VALID_CHECKSUM)

    def test_unknown_top_level_field_rejected_unless_x_prefixed(self) -> None:
        doc = json.loads((VECTOR_DIR / "minimal-valid.json").read_text(encoding="utf-8"))
        # Unprefixed extension -> must reject (forward-compat boundary).
        bad = dict(doc, somethingNew="x")
        with self.assertRaises(PpfValidationError):
            validate(bad)
        # x- prefixed -> must accept (spec §3 forward-compat rule).
        good = dict(doc, **{"x-vendor-tag": "internal"})
        validate(good)


if __name__ == "__main__":
    unittest.main()
