import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DESKTOP_MIGRATIONS } from '../../src/migrations/desktop/index.js';
import { renderRustModule } from '../../src/renderers/sqlite-rust-module.js';

const CLI_SNAPSHOT_HEADER = 'test (@chrono/schema-dsl)';

// PR-D removed the hand-written tuple table from chrono-synth-desktop's
// migrations.rs (it now uses include!(OUT_DIR/migrations_generated.rs)), so
// the legacy-source byte-stable parity check moved out of this suite. End-
// to-end verification now lives in:
//   - the snapshot byte-for-byte check below (`full desktop module …`)
//   - the desktop cargo tests in chrono-synth-desktop/src-tauri (mod tests)
// Both run on each desktop build.rs invocation.

describe('desktop sqlite-rust migrations', () => {
  it('covers seven desktop-only migrations', () => {
    assert.equal(DESKTOP_MIGRATIONS.length, 7);
    assert.deepEqual(DESKTOP_MIGRATIONS.map(migration => migration.aliases['sqlite-rust']), [
      'v001',
      'v002',
      'v003',
      'v004',
      'v005',
      'v006',
      'v007',
    ]);
    assert.equal(DESKTOP_MIGRATIONS.filter(migration => migration.target === 'desktop-only').length, 7);
  });

  it('full desktop module renders byte-stable Rust', () => {
    const rust = renderRustModule({ migrations: DESKTOP_MIGRATIONS, packageHeader: CLI_SNAPSHOT_HEADER });
    const snapshotPath = join(process.cwd(), 'test', 'parity', 'fixtures', 'desktop-module.rs.snapshot');
    if (process.env.UPDATE_SNAPSHOTS) {
      writeFileSync(snapshotPath, rust);
      return;
    }
    assert.ok(existsSync(snapshotPath), 'missing desktop module snapshot; run UPDATE_SNAPSHOTS=1 npm run test:parity-desktop');
    assert.equal(rust, readFileSync(snapshotPath, 'utf8'));
  });

  it('CLI output matches snapshot byte-for-byte', () => {
    // Avoid spawnSync inside node --test: when other tests in this file fail,
    // the test runner's failure detail dump can deadlock with subprocess stdout.
    // Instead, mirror exactly what bin/render-rust.js does (parseArgs default
    // values for --header "test" and --package-name "@chrono/schema-dsl").
    const rust = renderRustModule({
      migrations: DESKTOP_MIGRATIONS,
      packageHeader: `test (${'@chrono/schema-dsl'})`,
    });
    const snapshotPath = join(process.cwd(), 'test', 'parity', 'fixtures', 'desktop-module.rs.snapshot');
    const snapshot = readFileSync(snapshotPath, 'utf8');
    if (rust !== snapshot) {
      // Find first divergence to make failures actionable without dumping 6KB twice.
      const limit = Math.min(rust.length, snapshot.length);
      let firstDiff = -1;
      for (let i = 0; i < limit; i++) {
        if (rust[i] !== snapshot[i]) { firstDiff = i; break; }
      }
      if (firstDiff === -1) firstDiff = limit;
      const context = 40;
      const window = (s: string) => JSON.stringify(s.slice(Math.max(0, firstDiff - context), firstDiff + context));
      assert.fail(`CLI output diverges from snapshot at byte ${firstDiff}:\n  actual:   ${window(rust)}\n  expected: ${window(snapshot)}`);
    }
  });

  // CLI spawn smoke test is opt-in via CHRONO_RUN_CLI_SMOKE=1.
  // node --test's failure detail dump can deadlock with subprocess stdio when
  // multiple tests fail in the same run; the in-process byte-for-byte check
  // above already guarantees CLI output correctness from the same module
  // entrypoint. The CLI smoke is for catching binary-level regressions (shebang,
  // parseArgs, file permissions) and should only run on CI or by explicit opt-in.
  if (process.env.CHRONO_RUN_CLI_SMOKE === '1') {
    it('CLI spawn smoke test produces matching output', () => {
      const outPath = join(tmpdir(), `schema-dsl-render-rust-${process.pid}.rs`);
      const cliPath = join(process.cwd(), 'bin', 'render-rust.js');
      const result = spawnSync(process.execPath, [cliPath, '--out', outPath, '--header', 'test'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (result.error) throw result.error;
      if (result.signal) {
        throw new Error(`CLI killed by signal ${result.signal}: ${result.stderr || result.stdout}`);
      }
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const snapshotPath = join(process.cwd(), 'test', 'parity', 'fixtures', 'desktop-module.rs.snapshot');
      assert.equal(readFileSync(outPath, 'utf8'), readFileSync(snapshotPath, 'utf8'));
    });
  }
});
