# PPF v1 Test Vectors

Each `.json` file pairs with `PpfV1DocumentSchema` (from `@chrono/contracts`):

| Vector | Purpose |
|--------|---------|
| `minimal-valid.json` | Smallest document that should parse cleanly |
| `invalid-values-out-of-order.json` | `values` array violates the (-weight, id) ordering rule from spec §4 |

Add new vectors here when extending the spec; the runtime test that exercises them lives at `src/test/contract/ppf-v1-test-vectors.test.ts`.
