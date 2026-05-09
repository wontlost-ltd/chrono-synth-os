#!/usr/bin/env bash
# Run the Python PPF v1 reference implementation tests.
# No external deps; uses unittest from stdlib.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m unittest tests.test_vectors -v
