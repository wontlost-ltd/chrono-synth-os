# Parser Spike Notes

Date: 2026-05-14

## Spike Completed in PR2

Selected parsers:

- PostgreSQL: `pg-query-emscripten@5.1.0`
- SQLite: `node-sql-parser@5.4.0` with `database: "sqlite"`

Validated samples:

- `v001`: simple CREATE TABLE and CREATE INDEX statements.
- `v071_pg`: pgvector/HNSW sample in the spike, including vector syntax.
- partial index statements from the migration corpus.

The temporary `packages/schema-dsl/spike/` directory was deleted after the
results were folded into this note. The retained implementation lives under
`src/parity/`.

## Candidates Checked

The PR1 environment was checked with `require.resolve` for the requested parser
candidates:

- `pg-query-emscripten`: missing
- `@pgsql/parser`: missing
- `libpg-query`: missing
- `node-sqlite-parser`: missing
- `sqlite-parser`: missing

`typescript` is present and is used for legacy migration extraction.

## Historical PR1 Fallback

PR1 used a fallback mini DDL parser in
`test/parity/placeholder-mini-parser.ts`. That file was removed in PR2 and
replaced by the real parser entrypoints under `src/parity/`. The fallback only
covered the v001 fixture surface:

- `CREATE TABLE IF NOT EXISTS ...`
- `CREATE INDEX IF NOT EXISTS ...`
- `CREATE UNIQUE INDEX IF NOT EXISTS ...`
- basic column-name extraction
- whitespace/comment/identifier normalization

This was intentionally not the long-term AST parser. PR2 now uses
`pg-query-emscripten` for PostgreSQL and `node-sql-parser` for SQLite.

## Cost Of Fallback

The fallback parser is enough to demonstrate the pipeline, but it cannot safely
validate:

- complex CHECK expression equivalence
- ALTER TABLE operations
- trigger/function bodies
- pgvector HNSW index options
- DML backfill semantics
- SQLite table rebuild equivalence

If real parser packages remain unavailable, the fallback would need to grow into
a narrow project parser plus a stronger execution/dump diff gate. That is higher
risk than adopting libpg_query-compatible PG parsing and a SQLite parser package.
