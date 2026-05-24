#!/usr/bin/env node
/**
 * GA aggregate gate — runs every GA-relevant lint/audit across the
 * monorepo + its three sibling repos in a single command.
 *
 * Why this exists:
 *   `audit:ga-blockers` covers OS-side artifact presence (§8 #1-28),
 *   but each of the three sibling repos (chrono-synth-web,
 *   chrono-synth-desktop, chrono-synth-deploy) has its own GA lint
 *   that the OS auditor previously had to invoke by hand. CI and the
 *   release runbook both want one entrypoint that fails-fast on any
 *   GA regression across the four repos.
 *
 * Mechanics:
 *   - Each step declares { id, repo, repoPath, command, args, desc, optional? }.
 *   - repoPath defaults to OS_ROOT/../<sibling>; override per-repo via
 *     CHRONO_WEB_REPO / CHRONO_DESKTOP_REPO / CHRONO_DEPLOY_REPO.
 *   - Sibling repos that are not checked out are reported as `skipped`
 *     (not failed) by default. Pass `--require-siblings` (or set
 *     CHRONO_GA_REQUIRE_SIBLINGS=1) to convert "skip" into "fail" for
 *     release CI; the script then also pre-checks repo presence and
 *     emits ONE missing-repo failure per repo (rather than one per
 *     step in that repo).
 *   - Streaming progress to stderr with ▶/✓/✖/· markers.
 *   - Structured JSON report:
 *       - `--out=<path>`  → written to file (recommended CI contract).
 *                            Note: this only suppresses *the script's*
 *                            stdout; `npm run ga:check` will still
 *                            print npm's own banner unless invoked
 *                            with `npm run --silent ga:check` or the
 *                            compiled file is invoked directly via
 *                            `node dist/scripts/ga-check.js`.
 *       - default         → emitted to stdout AFTER a sentinel line
 *                            `=== ga:check json ===` so parsers can
 *                            still split on it even with the npm
 *                            banner present.
 *
 * Exit codes:
 *   0  every required step passed
 *   1  at least one required step failed
 *   2  invocation error (bad --timeout-ms / --out path, etc.)
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ESM-safe __dirname equivalent. The compiled JS lives in dist/scripts/
 * so resolving '..' gives us the chrono-synth-os repo root. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OS_ROOT = resolve(__dirname, '..', '..');
const REPOS_ROOT = resolve(OS_ROOT, '..');

interface StepDecl {
  id: string;
  repo: 'os' | 'web' | 'desktop' | 'deploy';
  repoPath: string;
  command: string;
  args: readonly string[];
  /** Marker so we can describe the step in summary output. */
  desc: string;
  /** Treat a missing repo / missing script as a skip rather than a fail. */
  optional?: boolean;
}

interface StepResult {
  id: string;
  repo: StepDecl['repo'];
  command: string;
  args: readonly string[];
  status: 'pass' | 'fail' | 'skipped';
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Last ~80 lines of stderr to surface the actionable error without
   * dumping the whole build log. */
  stderrTail: string;
  reason?: string;
}

/* ── Step inventory ───────────────────────────────────────────────── */

/* Sibling-repo locations are resolved relative to the OS repo by default
 * (the convention used by every contributor's working tree), but each
 * one can be overridden via env so CI workflows that lay out the repos
 * differently (e.g. monorepo runners, sparse checkouts) still work. */
const WEB = process.env.CHRONO_WEB_REPO ?? resolve(REPOS_ROOT, 'chrono-synth-web');
const DESKTOP = process.env.CHRONO_DESKTOP_REPO ?? resolve(REPOS_ROOT, 'chrono-synth-desktop');
const DEPLOY = process.env.CHRONO_DEPLOY_REPO ?? resolve(REPOS_ROOT, 'chrono-synth-deploy');

const STEPS: readonly StepDecl[] = [
  /* OS-side baseline. All required: the OS repo is always checked out
   * when this script runs (it lives here). */
  {
    id: 'os.audit-ga-blockers',
    repo: 'os',
    repoPath: OS_ROOT,
    command: 'npm',
    args: ['run', 'audit:ga-blockers', '--silent'],
    desc: '§8 #1-28 artifact presence + release-manifest contract',
  },
  {
    id: 'os.check-forbidden-imports',
    repo: 'os',
    repoPath: OS_ROOT,
    command: 'npm',
    args: ['run', 'check:forbidden-imports', '--silent'],
    desc: 'kernel purity / no-Node-imports in cross-runtime modules',
  },
  {
    id: 'os.lint-field-encryption',
    repo: 'os',
    repoPath: OS_ROOT,
    command: 'npm',
    args: ['run', 'lint:field-encryption', '--silent'],
    desc: 'P1-H field-encryption coverage across executors + plugins',
  },
  {
    id: 'os.codegen-design-tokens-check',
    repo: 'os',
    repoPath: OS_ROOT,
    command: 'npm',
    args: ['run', 'codegen:design-tokens:check', '--silent'],
    desc: 'design-token CSS output is in sync with source-of-truth',
  },
  {
    id: 'os.lint-contrast',
    repo: 'os',
    repoPath: OS_ROOT,
    command: 'npm',
    args: ['run', 'lint:contrast', '--silent'],
    desc: 'WCAG AA/AAA contrast lint across all three themes',
  },
  {
    id: 'os.sync-vendor-check',
    repo: 'os',
    repoPath: OS_ROOT,
    command: 'npm',
    args: ['run', 'sync:vendor:check', '--silent'],
    desc: 'vendored sibling packages match OS source',
  },

  /* Sibling repos. Optional so a CI run scoped to OS alone still
   * exits 0 — but if the sibling IS present, it must pass. */
  {
    id: 'web.typecheck',
    repo: 'web',
    repoPath: WEB,
    command: 'npm',
    args: ['run', 'typecheck', '--silent'],
    desc: 'web typecheck',
    optional: true,
  },
  {
    id: 'web.i18n-check',
    repo: 'web',
    repoPath: WEB,
    command: 'npm',
    args: ['run', 'i18n:check', '--silent'],
    desc: 'web i18n: no untranslated CJK literals in source',
    optional: true,
  },
  {
    id: 'desktop.typecheck',
    repo: 'desktop',
    repoPath: DESKTOP,
    command: 'npm',
    args: ['run', 'typecheck', '--silent'],
    desc: 'desktop typecheck',
    optional: true,
  },
  {
    id: 'desktop.lint-updater-pubkey',
    repo: 'desktop',
    repoPath: DESKTOP,
    command: 'npm',
    args: ['run', 'lint:updater-pubkey', '--silent'],
    desc: 'Tauri updater pubkey is not the placeholder',
    optional: true,
  },
  {
    id: 'desktop.test-lint-updater-pubkey',
    repo: 'desktop',
    repoPath: DESKTOP,
    command: 'npm',
    args: ['run', 'test:lint:updater-pubkey', '--silent'],
    desc: 'self-tests for the pubkey lint (10-case smoke)',
    optional: true,
  },
  {
    id: 'deploy.lint-compliance',
    repo: 'deploy',
    repoPath: DEPLOY,
    command: 'bash',
    args: ['scripts/lint-compliance.sh'],
    desc: 'Kyverno + ArgoCD AppProject + CODEOWNERS audit anchor',
    optional: true,
  },
];

/* ── Process orchestration ────────────────────────────────────────── */

const STDERR_TAIL_LIMIT_BYTES = 8 * 1024;

interface CmdOptions {
  timeoutMs: number;
}

async function runStep(step: StepDecl, opts: CmdOptions): Promise<StepResult> {
  const started = Date.now();

  /* Missing sibling repo → skip (or fail for non-optional steps). */
  if (!existsSync(step.repoPath) || !statSync(step.repoPath).isDirectory()) {
    return {
      id: step.id,
      repo: step.repo,
      command: step.command,
      args: step.args,
      status: step.optional ? 'skipped' : 'fail',
      durationMs: 0,
      exitCode: null,
      signal: null,
      stderrTail: '',
      reason: step.optional
        ? `sibling repo not checked out at ${step.repoPath}`
        : `required repo path missing: ${step.repoPath}`,
    };
  }

  return new Promise<StepResult>((resolveResult) => {
    /* stdin: 'ignore' (these are non-interactive lints).
     * stdout: 'ignore' — we discard child stdout entirely (each command
     *   owns its own output; we only care about exit code + stderr).
     *   'ignore' avoids spawning a drained pipe that the OS still
     *   buffers a few MB into before our no-op listener catches it.
     * stderr: 'pipe' so we can tail-buffer it for the failure report.
     *
     * `detached: true` makes the child the leader of its own process
     * group. Combined with `process.kill(-pid, signal)` on timeout
     * below, this signals every descendant (npm → bash → tsc → ...)
     * rather than only the immediate npm wrapper. */
    let child: ChildProcessByStdio<null, null, Readable>;
    try {
      child = spawn(step.command, [...step.args], {
        cwd: step.repoPath,
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });
    } catch (err) {
      resolveResult({
        id: step.id,
        repo: step.repo,
        command: step.command,
        args: step.args,
        status: 'fail',
        durationMs: Date.now() - started,
        exitCode: null,
        signal: null,
        stderrTail: '',
        reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    const appendStderr = (chunk: Buffer) => {
      /* Slice oversized chunks down to the tail-limit before pushing,
       * so the cap is strict even when a single chunk arrives larger
       * than STDERR_TAIL_LIMIT_BYTES (rare with pipe buffer ≤64KB but
       * possible under back-pressure). */
      const limited = chunk.length > STDERR_TAIL_LIMIT_BYTES
        ? chunk.subarray(chunk.length - STDERR_TAIL_LIMIT_BYTES)
        : chunk;
      stderrChunks.push(limited);
      stderrBytes += limited.length;
      while (stderrBytes > STDERR_TAIL_LIMIT_BYTES && stderrChunks.length > 1) {
        const dropped = stderrChunks.shift()!;
        stderrBytes -= dropped.length;
      }
    };

    child.stderr.on('data', appendStderr);

    let settled = false;
    let timeoutFired = false;
    /* Track BOTH timers (initial timeout + post-SIGTERM grace) so we
     * can cancel them on close. Leaving a delayed SIGKILL armed after
     * the child has already exited keeps the parent alive longer than
     * necessary and — if the OS reuses the freed PGID before our
     * setTimeout fires — could signal an unrelated process group.
     * Belt-and-braces: clear them both from every settle path. */
    let initialTimer: NodeJS.Timeout | null = null;
    let killGraceTimer: NodeJS.Timeout | null = null;
    const clearTimers = (): void => {
      if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
      if (killGraceTimer) { clearTimeout(killGraceTimer); killGraceTimer = null; }
    };
    const finalise = (result: StepResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolveResult(result);
    };

    /* Group-kill helper. spawn(detached:true) means child.pid leads
     * the new process group; signalling -pid reaches every descendant
     * including grandchildren (npm → node → tsc, bash → sub-script). */
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); }
      catch { /* group already gone */ }
    };

    initialTimer = setTimeout(() => {
      timeoutFired = true;
      killGroup('SIGTERM');
      /* If SIGTERM doesn't take within 5s, force-kill the whole tree.
       * Tracked in killGraceTimer so the close handler can cancel it
       * once the child has actually exited (most children honour
       * SIGTERM well before 5s). */
      killGraceTimer = setTimeout(() => {
        killGraceTimer = null;
        killGroup('SIGKILL');
      }, 5_000);
    }, opts.timeoutMs);

    child.on('error', (err) => {
      /* Wait for close to confirm process+streams are gone before we
       * settle, otherwise the next step could start while the failed
       * child is still tearing down. */
      child.once('close', () => {
        finalise({
          id: step.id,
          repo: step.repo,
          command: step.command,
          args: step.args,
          status: 'fail',
          durationMs: Date.now() - started,
          exitCode: null,
          signal: null,
          stderrTail: Buffer.concat(stderrChunks).toString('utf8'),
          reason: `child error: ${err.message}`,
        });
      });
    });

    /* 'close' fires after both 'exit' AND stdio streams have closed —
     * use it (not 'exit') so we don't race against an in-flight tail
     * buffer write or leave the next step contending with a still-
     * dying process. */
    child.on('close', (code, signal) => {
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const reason = timeoutFired
        ? `timed out after ${opts.timeoutMs}ms`
        : undefined;
      const result: StepResult = {
        id: step.id,
        repo: step.repo,
        command: step.command,
        args: step.args,
        status: timeoutFired || code !== 0 ? 'fail' : 'pass',
        durationMs: Date.now() - started,
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        stderrTail: timeoutFired || code !== 0 ? stderrTail : '',
      };
      if (reason !== undefined) result.reason = reason;
      finalise(result);  /* clearTimers happens inside finalise */
    });
  });
}

/* ── Output ───────────────────────────────────────────────────────── */

interface ProgressFmt {
  jsonOnly: boolean;
}

function emitProgress(line: string, fmt: ProgressFmt): void {
  if (fmt.jsonOnly) return;
  process.stderr.write(`${line}\n`);
}

function summarise(results: readonly StepResult[]): {
  pass: number;
  fail: number;
  skipped: number;
  durationMs: number;
} {
  return results.reduce(
    (acc, r) => ({
      pass: acc.pass + (r.status === 'pass' ? 1 : 0),
      fail: acc.fail + (r.status === 'fail' ? 1 : 0),
      skipped: acc.skipped + (r.status === 'skipped' ? 1 : 0),
      durationMs: acc.durationMs + r.durationMs,
    }),
    { pass: 0, fail: 0, skipped: 0, durationMs: 0 },
  );
}

function formatStatus(status: StepResult['status']): string {
  switch (status) {
    case 'pass': return '✓';
    case 'fail': return '✖';
    case 'skipped': return '·';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes('--json');
  /* Optional: write the structured report to a file instead of stdout.
   * This is the recommended CI contract because `npm run ga:check`
   * writes its own banner ("> chrono-synth-os@2.0.0 ga:check\n> ...")
   * to stdout BEFORE our script runs, which pollutes any caller that
   * tries to parse stdout as a single JSON document. Using --out=<path>
   * sidesteps that entirely. Direct invocation
   * (`node dist/scripts/ga-check.js --json`) also avoids the banner
   * but requires the caller to bypass npm. */
  const outArg = args.find((a) => a.startsWith('--out='));
  const outPath = outArg ? outArg.slice('--out='.length) : null;
  /* Release-strict mode: every sibling repo MUST be present + every
   * step MUST pass. Use this in the release CI pipeline so a missing
   * sibling can't sneak past the gate. Default (off) keeps OS-only
   * dev loops fast. Env var is the more CI-natural switch. */
  const requireSiblings = args.includes('--require-siblings')
    || process.env.CHRONO_GA_REQUIRE_SIBLINGS === '1';

  /* Default 10 min per step — long enough for full typecheck runs in
   * a cold-cache environment, short enough that a hung process can't
   * stall the whole gate indefinitely. Validate strictly so a
   * fat-fingered CI invocation doesn't yield zero/NaN/negative
   * timeouts that make every step instantly time out. */
  const timeoutArg = args.find((a) => a.startsWith('--timeout-ms='));
  let timeoutMs = 10 * 60_000;
  if (timeoutArg !== undefined) {
    const parsed = Number(timeoutArg.slice('--timeout-ms='.length));
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      process.stderr.write(`invalid --timeout-ms (must be a positive integer): ${timeoutArg}\n`);
      process.exit(2);
    }
    timeoutMs = parsed;
  }

  const fmt: ProgressFmt = { jsonOnly };
  emitProgress(
    `ga:check — ${STEPS.length} steps; timeout/step=${timeoutMs}ms${requireSiblings ? '; require-siblings=on' : ''}`,
    fmt,
  );

  /* In require-siblings mode, override `optional: true` to false so a
   * missing sibling repo registers as a failure instead of a skip.
   * Pre-flight repo presence check emits ONE missing-repo failure per
   * sibling rather than fanning out into one failure per step in that
   * repo — cleaner per-repo reporting in the JSON summary. */
  const effectiveSteps: readonly StepDecl[] = requireSiblings
    ? STEPS.map((s) => ({ ...s, optional: false }))
    : STEPS;

  const results: StepResult[] = [];

  if (requireSiblings) {
    const missingRepos = new Map<StepDecl['repo'], string>();
    for (const step of STEPS) {
      if (step.repo === 'os') continue;
      if (missingRepos.has(step.repo)) continue;
      if (!existsSync(step.repoPath) || !statSync(step.repoPath).isDirectory()) {
        missingRepos.set(step.repo, step.repoPath);
      }
    }
    for (const [repo, repoPath] of missingRepos) {
      const stepId = `${repo}.repo-present`;
      emitProgress(`  ▶ ${stepId} (sibling repo presence in require-siblings mode)`, fmt);
      emitProgress(`    ✖ ${stepId} — required repo path missing: ${repoPath}`, fmt);
      results.push({
        id: stepId,
        repo,
        command: '(presence-check)',
        args: [],
        status: 'fail',
        durationMs: 0,
        exitCode: null,
        signal: null,
        stderrTail: '',
        reason: `required repo path missing: ${repoPath}`,
      });
    }
    /* Steps for missing repos are still emitted (so the report stays
     * shape-consistent) but report as fail with the same reason — the
     * per-repo presence failure above is the human-visible summary. */
  }

  for (const step of effectiveSteps) {
    emitProgress(`  ▶ ${step.id} (${step.desc})`, fmt);
    const result = await runStep(step, { timeoutMs });
    const tag = formatStatus(result.status);
    const detail = result.status === 'pass'
      ? `${result.durationMs}ms`
      : result.reason ?? `exit=${result.exitCode}`;
    emitProgress(`    ${tag} ${result.id} — ${detail}`, fmt);
    if (result.status === 'fail' && result.stderrTail) {
      const lines = result.stderrTail.trimEnd().split('\n').slice(-12);
      for (const line of lines) emitProgress(`      | ${line}`, fmt);
    }
    results.push(result);
  }

  const summary = summarise(results);
  const finalReport = {
    timestamp: new Date().toISOString(),
    osRepo: OS_ROOT,
    repos: { web: WEB, desktop: DESKTOP, deploy: DEPLOY },
    summary,
    results,
  };

  const jsonReport = JSON.stringify(finalReport, null, 2);
  if (outPath !== null) {
    /* CI-friendly: structured report goes to a dedicated file, stdout
     * stays clean for human readers (or stays empty if --json mode). */
    try {
      writeFileSync(outPath, `${jsonReport}\n`, 'utf8');
      emitProgress(`ga:check report written to ${outPath}`, fmt);
    } catch (err) {
      process.stderr.write(`failed to write ga:check report to ${outPath}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
  } else {
    /* Direct-invocation contract: JSON on stdout, separated from any
     * preceding text by a sentinel line so parsers can split on it
     * even when npm prepends its banner (`> chrono-synth-os ... ga:check`).
     * Tools that want JSON-only should pass --out=<path>. */
    process.stdout.write('=== ga:check json ===\n');
    process.stdout.write(`${jsonReport}\n`);
  }

  emitProgress('', fmt);
  emitProgress(
    `ga:check summary — pass=${summary.pass} fail=${summary.fail} skipped=${summary.skipped} total_ms=${summary.durationMs}`,
    fmt,
  );

  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`ga:check invocation error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
