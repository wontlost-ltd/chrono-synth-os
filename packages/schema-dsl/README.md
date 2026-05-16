# @wontlost-ltd/schema-dsl

Declarative schema DSL for ChronoSynth migrations.

Status: PR6 — server runtime executes DSL-rendered migrations directly. The
old handwritten server migration files and feature flag rollback path have been
removed.

This package is a build-time tool. It will eventually render the canonical schema
history to three targets:

- `postgres`: SQL for the Node PostgreSQL runner.
- `sqlite-sql`: SQL for the Node SQLite runner.
- `sqlite-rust`: Rust source wrapping SQLite/SQLCipher SQL for desktop builds.

The package includes an AST-backed parity harness:

- PostgreSQL: `pg-query-emscripten@5.1.0`
- SQLite: `node-sql-parser@5.4.0` with `database: "sqlite"`

Server runtime migrations are wired to this package through the DSL runner
exports in `src/storage/index.ts`.

## AST Normalization

`src/parity/normalize.ts` converts parser-specific ASTs into a shared canonical
structure before diffing. It does not silently fall back to string comparison:
unsupported AST nodes throw `UnnormalizableDiff` so the migration can be handled
explicitly.

Currently supported AST statement nodes:

- PostgreSQL `CreateStmt`
- PostgreSQL `IndexStmt`
- PostgreSQL `AlterTableStmt` with `AT_AddColumn`
- PostgreSQL `DropStmt`
- SQLite `create table`
- SQLite `create index`
- SQLite `alter table add column`
- SQLite `alter table rename to`
- SQLite `drop table`

Currently supported expression/constraint nodes:

- Column-level `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT`, `CHECK`, and
  `REFERENCES`
- Table-level `PRIMARY KEY`, `UNIQUE`, `CHECK`, and `FOREIGN KEY`
- PostgreSQL `A_Expr`, `BoolExpr`, `ColumnRef`, `A_Const`, `List`, and
  `NullTest`
- SQLite `binary_expr`, `column_ref`, `number`, quoted string, `null`, `origin`,
  and `expr_list`

## Dialect Mapping

| DSL type | postgres | sqlite-sql | sqlite-rust | Notes |
|---|---|---|---|---|
| `text` | `TEXT` | `TEXT` | `TEXT` | JSON payloads remain text. |
| `integer` | `INTEGER` | `INTEGER` | `INTEGER` | Historical boolean-like columns use this too. |
| `bigint` | `BIGINT` | `INTEGER` | `INTEGER` | Epoch ms timestamps map here. |
| `real` | `DOUBLE PRECISION` | `REAL` | `REAL` | Matches current PG/SQLite history. |
| `double` | `DOUBLE PRECISION` | `REAL` | `REAL` | Semantic alias for explicit doubles. |
| `boolean` | `BOOLEAN` | `INTEGER CHECK (col IN (0,1))` | `INTEGER CHECK (col IN (0,1))` | New migrations only. |
| `timestamp` | `BIGINT` | `INTEGER` | `INTEGER` | Defaults to epoch ms integer semantics. |
| `vector` | `vector(n)` | error | error | PG-only. |

> Historical boolean rule
>
> When rewriting historical migrations, boolean-like fields must use
> `type: "integer"`. Reserve `type: "boolean"` for v074+ migrations only.
> AST parity must not introduce `BOOLEAN` or new boolean CHECK constraints into
> historical SQL that never had them.

## Raw Migration Rule

These 9 migrations must use `defineRawMigration`. Do not express them with the
schema DSL in PR2/PR3:

- `v007`: SQLite table rebuild plus copy; PG in-place singleton table PK change.
- `v027`: identities/avatars backfill DML.
- `v030`: CHECK constraint rewrite; SQLite rebuild vs PG drop/add constraint.
- `v034`: lifecycle_status backfill with known SQLite/PG NULL semantic difference.
- `v040`: audit_log backfill UPDATE.
- `v041`: runtime_sessions rebuild/CHECK/data update.
- `v047`: identity/avatar multi-table rebuild.
- `v052`: event_ledger_authority singleton seed.
- `v071_pg`: pgvector extension/vector column/PL/pgSQL trigger/HNSW index.

PG `v072` is represented separately as `disabled: true`; it remains excluded
from the enabled execution list.

## Adding a Migration

Current flow:

1. Add a `defineMigration` entry under `src/migrations/server-simple/` for
   simple schema migrations. Use `v001.ts` as the reference shape: aliases,
   description, then ordered operations.
2. Add aliases for every target that should render it, e.g.
   `{ postgres: "v001", "sqlite-sql": "v001" }`.
3. For historical migrations, use `type: "integer"` for boolean-like fields.
4. Add the migration to `SERVER_SIMPLE_MIGRATIONS` in version order.
5. Run `npm run test --workspace @wontlost-ltd/schema-dsl`.
6. If a migration is raw or requires DML/table rebuild semantics, do not encode
   it as schema DSL. Use `defineRawMigration` in PR3.

## Server Runtime Integration

`src/storage/dsl-migrations-runner.ts` renders all enabled server migrations
from `VERSION_MAP` order and applies them through the same `IDatabase`
interface used by the rest of the storage layer.

- PostgreSQL records `schema_migrations.version` as `TEXT` and
  `applied_at` as `BIGINT`.
- SQLite records `schema_migrations.version` as `TEXT` and `applied_at` as
  `INTEGER`.
- SQLite preserves the legacy `safe:add-column` and `safe:if-table-exists`
  marker behavior so partially initialized or older databases remain
  idempotent.

The deleted handwritten SQL is preserved only as root integration-test
fixtures. Those tests execute the frozen baseline and the DSL output against
real SQLite/PostgreSQL catalogs to catch drift after PR6.

## Desktop Integration

The desktop repository consumes `@wontlost-ltd/schema-dsl` as a build-time package.
Its `src-tauri/build.rs` resolves the Rust renderer CLI in this order:

1. `CHRONO_SCHEMA_DSL_CLI`
2. `../node_modules/.bin/schema-dsl-render-rust`
3. `../node_modules/@wontlost-ltd/schema-dsl/bin/render-rust.js`

The build script writes `migrations_generated.rs` into Cargo `OUT_DIR`.
`src-tauri/src/db/migrations.rs` includes that generated file and keeps the
public `run_migrations(conn: &Connection) -> Result<()>` API stable while
iterating over `DESKTOP_MIGRATIONS`.

After this package is published to GitHub Packages, the desktop repository
should install it with `npm install @wontlost-ltd/schema-dsl`. Developer worktrees and
CI overrides can use the env var fallback without requiring `node_modules`.

## Verification Notes

- `npm run test:schema-dsl-parity:simple` covers v001-v010 except v007 across
  PostgreSQL and SQLite.
- `npm run test --workspace @wontlost-ltd/schema-dsl` also runs sabotage
  self-checks proving type, CHECK, column-order, nullable, and CHECK-whitespace
  behavior.

## Running Integration Tests Locally

The schema-dsl integration tests live in the root `src/test/integration`
directory so the build-time package does not import runtime database clients.
They execute the legacy migrations and DSL-rendered migrations against real
databases, then compare catalog dumps.

```bash
# macOS + Podman example; use the socket for your local machine.
export DOCKER_HOST="unix:///var/folders/42/vrxsf6r14p7f46p5q2040ggw0000gn/T/podman/podman-machine-api.sock"

npm run build --workspace @wontlost-ltd/schema-dsl
npm run test:integration:schema-dsl
```

If Node is configured with macOS system CA access and fails before
testcontainers starts with `SecItemCopyMatching failed -50`, run the same
command with `NODE_USE_SYSTEM_CA` unset. The npm script already does this for
the spawned TypeScript and Node processes.

The PostgreSQL test uses `pgvector/pgvector:pg16`. CI uses the default Docker
socket; no `DOCKER_HOST` override is required there.

## Publishing

`@wontlost-ltd/schema-dsl` publishes to GitHub Packages on tag push.

### Releasing a new version

1. Bump `version` in `package.json`
2. Update `CHANGELOG.md` (if exists)
3. Run all tests: `npm run test --workspace @wontlost-ltd/schema-dsl`
4. Tag: `git tag schema-dsl-v<new-version>`
5. Push: `git push origin schema-dsl-v<new-version>`
6. CI publishes via `.github/workflows/publish-schema-dsl.yml`

### Consuming from another package

```bash
# .npmrc in consumer repo
@chrono:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}

# Then
npm install @wontlost-ltd/schema-dsl
```

For desktop `build.rs` integration, see PR-D documentation.
