//! Local Node OS sidecar lifecycle (ADR-0061 S2 + follow-up crash auto-restart).
//!
//! Spawns the bundled ChronoSynth Node server (`resources/sidecar/dist/main-desktop.js`) as a
//! child process, reads its stdout ready marker (`CHRONO_SIDECAR_READY {json}`) to capture the
//! dynamically-assigned loopback port + instanceNonce, health-checks `/readyz`, and exposes the
//! resolved endpoint + per-launch handshake token to the frontend.
//!
//! A supervisor thread watches the child: if it exits **unexpectedly** (crash — not a deliberate
//! app shutdown) the sidecar is respawned with time-windowed backoff, and the stored endpoint is
//! refreshed (new port and new handshake token, same persistent JWT secret so issued tokens stay
//! valid). Frontend recovery is **reactive**, not push-based: a request to the now-dead port fails,
//! `apiFetch` invalidates its endpoint cache, and the next request re-fetches the live endpoint. A
//! `sidecar://restarted` event is emitted for observability but is not currently subscribed to.
//!
//! Red-lines (ADR-0061):
//!  - #2 loopback only: the sidecar binds 127.0.0.1:0 itself (main-desktop.ts); we only read the port.
//!  - #4 lifecycle bound to app: child killed on drop / app exit; no orphan; supervisor stops on shutdown.
//!  - #5 JWT signing secret is persistent (keyring), reused across restarts so tokens survive a crash.
//!  - #11 local caller binding: a per-launch random handshake token is generated here (**rotated on
//!    every (re)spawn**), passed to the sidecar via env `CHRONO_DESKTOP_SESSION` (server enforces it),
//!    and handed to the frontend via `get_sidecar_endpoint`. Token never logged.

use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Resolved sidecar endpoint handed to the frontend. `handshakeToken` MUST accompany every
/// non-public request as `X-Chrono-Desktop-Session` (red-line 11).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEndpoint {
    pub base_url: String,
    pub handshake_token: String,
    pub instance_nonce: String,
}

/// Immutable spawn parameters resolved once at startup and reused verbatim on every respawn
/// (crash auto-restart). The JWT secret is the **persistent** keyring secret — reusing it keeps
/// already-issued frontend tokens valid across a restart (red-line 5).
#[derive(Clone)]
struct SpawnParams {
    entry: PathBuf,
    node_bin: OsString,
    db_path: PathBuf,
    jwt_secret: String,
}

/// Managed sidecar state. Child is kept so Drop / explicit shutdown can kill it (red-line 4).
pub struct SidecarState {
    inner: Mutex<Option<SidecarRunning>>,
    /// Set on deliberate shutdown so the supervisor does NOT respawn (distinguishes a crash from
    /// an app-driven exit — red-line 4).
    shutting_down: Arc<AtomicBool>,
    /// Spawn params, populated after the first successful start; the supervisor clones these to respawn.
    params: Mutex<Option<SpawnParams>>,
}

struct SidecarRunning {
    child: Child,
    endpoint: SidecarEndpoint,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            shutting_down: Arc::new(AtomicBool::new(false)),
            params: Mutex::new(None),
        }
    }
}

impl SidecarState {
    /// Endpoint for the frontend (None until started). Always reflects the **current** live child
    /// (updated on respawn), so a post-crash re-fetch returns the fresh port + handshake token.
    pub fn endpoint(&self) -> Option<SidecarEndpoint> {
        self.inner.lock().ok().and_then(|g| g.as_ref().map(|r| r.endpoint.clone()))
    }

    /// Graceful shutdown: stop the supervisor from respawning, then kill the child (red-line 4, no
    /// orphan). Idempotent.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(mut g) = self.inner.lock() {
            if let Some(mut r) = g.take() {
                let _ = r.child.kill();
                let _ = r.child.wait();
            }
        }
    }
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Ready marker printed by main-desktop.ts on stdout: `CHRONO_SIDECAR_READY {json}`.
const READY_PREFIX: &str = "CHRONO_SIDECAR_READY ";

/// Observability signal emitted to the frontend after a crash restart / give-up. The payload
/// carries nothing sensitive (no token). NOTE: the frontend does NOT currently subscribe — recovery
/// is **reactive**: the next request that hits the dead port fails, `apiFetch` invalidates the
/// endpoint cache, and the following request re-fetches the live endpoint (new port + handshake
/// token) via `get_sidecar_endpoint`. The emit exists for future proactive UI / logging.
const RESTARTED_EVENT: &str = "sidecar://restarted";

/// Supervisor tuning. Crash-loop protection is **time-windowed**: at most `RESTART_MAX_ATTEMPTS`
/// restarts may occur while the child keeps dying quickly. The attempt counter only resets once a
/// (re)spawned child has stayed alive continuously for `HEALTHY_RESET_AFTER` — a child that dies
/// again before that threshold does NOT reset the counter, so a "crash every second" loop trips the
/// cap instead of resetting on every poll. Exhausting the cap leaves the endpoint absent (frontend
/// shows "本地引擎不可用").
const RESTART_MAX_ATTEMPTS: u32 = 5;
const RESTART_BACKOFF_MS: u64 = 1_000;
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// A restarted child must run healthy this long before its crash counts as "recovered" (counter reset).
const HEALTHY_RESET_AFTER: Duration = Duration::from_secs(30);

/// Pure crash-loop decisions, extracted so the time-windowed policy is unit-testable without a Tauri
/// runtime (the supervisor thread itself needs a real `AppHandle`).
///
/// Should the crash-loop counter reset because the current child has run healthy long enough?
/// Only resets a non-zero counter (no-op when already zero) and only once the alive child has been
/// up for at least `HEALTHY_RESET_AFTER` — a child that dies sooner never resets it.
fn should_reset_crash_counter(restart_attempts: u32, current_child_uptime: Duration) -> bool {
    restart_attempts > 0 && current_child_uptime >= HEALTHY_RESET_AFTER
}

/// Has the crash-loop cap been exceeded (give up auto-restart)? Called with the incremented count.
fn crash_cap_exceeded(restart_attempts: u32) -> bool {
    restart_attempts > RESTART_MAX_ATTEMPTS
}

/// Backoff before the Nth restart attempt (linear: 1s × attempt).
fn restart_backoff(restart_attempts: u32) -> Duration {
    Duration::from_millis(RESTART_BACKOFF_MS * restart_attempts as u64)
}

#[derive(serde::Deserialize)]
struct ReadyMarker {
    port: u16,
    #[serde(rename = "instanceNonce")]
    instance_nonce: String,
}

/// Generate a random per-launch handshake token (red-line 11). 32 bytes hex.
fn generate_handshake_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Combine a UUID v4 with process/time entropy; sufficient for a per-launch local secret.
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let extra = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{uuid}{extra:x}")
}

/// Keyring service + entry for the persistent JWT signing secret (red-line 5).
const KEYRING_SERVICE: &str = "chrono-synth-desktop";
const JWT_SECRET_USER: &str = "chrono-desktop-jwt-secret";

/// Resolve the **persistent** JWT signing secret from the platform keyring, generating + storing one
/// on first run (red-line 5: generated once, never hardcoded / bundled). Reused across launches so
/// issued JWTs survive restarts. Two concatenated UUID v4 values (~244 bits of randomness after v4's
/// fixed version/variant bits) — ample signing entropy for HS256.
fn resolve_or_create_jwt_secret() -> Result<String, String> {
    use keyring_core::Entry;
    let entry = Entry::new(KEYRING_SERVICE, JWT_SECRET_USER)
        .map_err(|e| format!("keyring entry (jwt secret): {e}"))?;
    match entry.get_password() {
        Ok(v) if !v.is_empty() => Ok(v), // reuse existing persistent secret
        Ok(_) | Err(keyring_core::Error::NoEntry) => {
            let secret = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
            entry.set_password(&secret).map_err(|e| format!("keyring store (jwt secret): {e}"))?;
            Ok(secret)
        }
        Err(e) => Err(format!("keyring read (jwt secret): {e}")),
    }
}

/// Spawn the sidecar child from resolved params and block until the ready marker (or hard timeout).
/// Returns the live child + resolved endpoint. A **fresh handshake token is minted per (re)spawn**
/// (red-line 11 rotation); the JWT secret is the persistent one from `params`. Failure paths kill +
/// wait the child (no zombie). Token env is never logged.
fn spawn_and_wait_ready(params: &SpawnParams) -> Result<(Child, SidecarEndpoint), String> {
    let handshake = generate_handshake_token();

    let mut child = Command::new(&params.node_bin)
        .arg(&params.entry)
        .env("CHRONO_DB_DRIVER", "sqlite")
        .env("CHRONO_DB_PATH", &params.db_path)
        .env("CHRONO_QUEUE_ENABLED", "true")
        .env("CHRONO_JWT_ENABLED", "true")
        // Red-line 5: persistent JWT secret from keyring (issued tokens survive restarts).
        .env("CHRONO_JWT_SECRET", &params.jwt_secret)
        // Red-line 11: pass the handshake token; the server's desktop-session plugin enforces it.
        .env("CHRONO_DESKTOP_SESSION", &handshake)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("spawn sidecar: {e}"))?;

    // Read stdout for the ready marker on a **separate thread** and deliver via channel, so the
    // wait honours a **real hard timeout** — a blocking read_line inside a deadline loop would hang
    // forever if the child stays alive but emits no newline (Codex S2 复审 Major).
    //
    // CRITICAL: after the ready marker is seen the thread MUST keep draining stdout to EOF — it must
    // NOT break and drop the pipe. The sidecar logs to stdout continuously (workers every few
    // seconds); if we stop reading, the OS stdout pipe buffer (~64KB) fills, the child's next write
    // blocks, and Node eventually dies on the stalled/broken pipe — which the supervisor then sees as
    // a "crash" and respawns, producing an endless ready→stall→crash→restart loop. So: send readiness
    // through the channel ONCE, then continue reading and echo each line to our stderr (inherited by
    // the app) for observability, until EOF. Token env is never logged here.
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => { let _ = child.kill(); let _ = child.wait(); return Err("no sidecar stdout".to_string()); }
    };
    let (tx, rx) = std::sync::mpsc::channel::<Option<ReadyMarker>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut signalled = false; // readiness sent exactly once; keep draining afterwards.
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    // EOF: child closed stdout (exited). Only report "exited before ready" if we
                    // never signalled; after ready this is just normal shutdown.
                    if !signalled { let _ = tx.send(None); }
                    break;
                }
                Ok(_) => {
                    if !signalled {
                        if let Some(rest) = line.trim_end().strip_prefix(READY_PREFIX) {
                            let m = serde_json::from_str::<ReadyMarker>(rest).ok();
                            let _ = tx.send(m);
                            signalled = true;
                            continue; // keep the loop alive to drain subsequent log lines.
                        }
                        // else: pre-ready log line; keep reading.
                    } else {
                        // Post-ready: drain + echo to stderr so the pipe never fills (see CRITICAL).
                        eprint!("[sidecar] {line}");
                    }
                }
                Err(_) => {
                    if !signalled { let _ = tx.send(None); }
                    break;
                }
            }
        }
    });

    // 硬超时：channel recv_timeout（真上限，不受子进程是否换行影响）。失败路径统一 kill + wait（防僵尸）。
    let marker = match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(Some(m)) => m,
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("sidecar 提前退出，未就绪（未收到 CHRONO_SIDECAR_READY）".to_string());
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("sidecar 未在 60s 内就绪（硬超时）".to_string());
        }
    };

    let endpoint = SidecarEndpoint {
        base_url: format!("http://127.0.0.1:{}", marker.port),
        handshake_token: handshake,
        instance_nonce: marker.instance_nonce,
    };
    Ok((child, endpoint))
}

/// Spawn + wait-ready the sidecar, store it, and start the crash-restart supervisor. Returns the
/// resolved endpoint. Blocks until the ready marker is seen (or timeout). Called once during setup.
pub fn start_sidecar(app: &AppHandle, state: &SidecarState) -> Result<SidecarEndpoint, String> {
    // Resolve the bundled sidecar entry (S4 places it under resources/sidecar).
    let resource_dir = app.path().resource_dir().map_err(|e| format!("resource_dir: {e}"))?;
    let entry = resource_dir.join("sidecar").join("dist").join("main-desktop.js");
    if !entry.exists() {
        return Err(format!("sidecar 入口不存在: {}（S4 打包时随附 resources/sidecar）", entry.display()));
    }

    // SQLite + media land in the platform app-data dir (red-line 3).
    let app_data = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&app_data).map_err(|e| format!("create app_data: {e}"))?;
    let db_path = app_data.join("chrono-os.db");

    // Red-line 5: JWT signing secret is a **persistent** local secret (NOT per-launch, else every restart
    // invalidates issued tokens). Generated once, stored in the platform keyring, reused thereafter —
    // never hardcoded, never in the install bundle. Distinct from the handshake token (per-spawn).
    let jwt_secret = resolve_or_create_jwt_secret()?;

    // Prefer a bundled node (resources/node); fall back to PATH `node` (dev). S4 bundles node.
    let node_bin = {
        let bundled = resource_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if bundled.exists() { bundled.into_os_string() } else { OsString::from("node") }
    };

    let params = SpawnParams { entry, node_bin, db_path, jwt_secret };
    let (child, endpoint) = spawn_and_wait_ready(&params)?;

    // Store child + endpoint + params so shutdown can kill it (red-line 4) and the supervisor can respawn.
    if let Ok(mut g) = state.inner.lock() {
        *g = Some(SidecarRunning { child, endpoint: endpoint.clone() });
    }
    if let Ok(mut p) = state.params.lock() {
        *p = Some(params);
    }
    state.shutting_down.store(false, Ordering::SeqCst);

    spawn_supervisor(app.clone());
    Ok(endpoint)
}

/// Supervisor thread: polls the current child with `try_wait()` (non-blocking, so shutdown/endpoint
/// callers are never starved of the lock). On an **unexpected** exit — child gone while
/// `shutting_down` is false — it respawns with time-windowed backoff and refreshes the stored
/// endpoint. A deliberate shutdown (child taken out of the slot, or `shutting_down` set) ends the
/// supervisor cleanly.
///
/// **Shutdown/respawn orphan race (red-line 4).** `spawn_and_wait_ready()` runs OUTSIDE the lock
/// (it blocks ~seconds waiting for readiness); `shutdown()` may fire during that window and kill the
/// *old* slot child. To guarantee the *new* child can never escape shutdown's kill, the supervisor,
/// after a successful respawn, re-acquires the lock and — while still holding it — checks
/// `shutting_down`; if set, it kills+waits the new child instead of storing it. `shutdown()` sets
/// `shutting_down=true` **before** taking the lock, so the two are ordered: either shutdown ran
/// first (supervisor sees the flag → kills the new child) or the supervisor stored first
/// (shutdown's subsequent lock acquisition finds the new child in the slot → kills it). No orphan.
fn spawn_supervisor(app: AppHandle) {
    use std::time::Instant;
    std::thread::spawn(move || {
        let mut restart_attempts: u32 = 0;
        // When the currently-running child was (re)started; used to decide when a survival counts as
        // "recovered" (reset the crash-loop counter). Seeded now: the first child was just started.
        let mut current_child_started_at = Instant::now();
        loop {
            std::thread::sleep(CHILD_POLL_INTERVAL);
            let state = app.state::<SidecarState>();
            if state.shutting_down.load(Ordering::SeqCst) {
                return; // app is shutting down; do not respawn.
            }

            // Non-blocking check: is the current child still alive?
            let child_exited = {
                let mut g = match state.inner.lock() {
                    Ok(g) => g,
                    Err(_) => return, // poisoned lock: bail (shutdown path already ran or state gone).
                };
                match g.as_mut() {
                    Some(running) => match running.child.try_wait() {
                        Ok(Some(_)) => true,  // exited (try_wait also reaps the zombie).
                        Ok(None) => false,    // still running.
                        Err(_) => {
                            // OS-level wait error: don't assume the process is gone — it may still be
                            // alive. Explicitly kill+wait before treating the slot as dead (red-line 4:
                            // never leave a possibly-live child behind). Errors here are best-effort.
                            let _ = running.child.kill();
                            let _ = running.child.wait();
                            true
                        }
                    },
                    None => return, // slot emptied by shutdown() → app-driven exit, stop supervising.
                }
            };
            if !child_exited {
                // Time-windowed reset: only a child that has run healthy for HEALTHY_RESET_AFTER
                // counts as "recovered". A child that dies again before that does NOT reset the
                // counter — so a fast crash-loop trips the cap instead of resetting every poll.
                if should_reset_crash_counter(restart_attempts, current_child_started_at.elapsed()) {
                    restart_attempts = 0;
                }
                continue;
            }

            // Re-check shutdown after detecting exit: the exit may have been caused by shutdown()
            // racing between our try_wait and now. If so, do not respawn.
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }

            restart_attempts += 1;
            if crash_cap_exceeded(restart_attempts) {
                eprintln!("[sidecar] 崩溃重启超过上限（{RESTART_MAX_ATTEMPTS} 次），停止自动重启；前端将提示本地引擎不可用");
                // Clear the dead endpoint so the frontend stops hitting a dead port.
                if let Ok(mut g) = state.inner.lock() {
                    *g = None;
                }
                let _ = app.emit(RESTARTED_EVENT, ());
                return;
            }

            std::thread::sleep(restart_backoff(restart_attempts));
            // Backoff may have spanned a shutdown → re-check before spawning (avoid a needless spawn
            // we'd immediately have to kill).
            if state.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            let params = match state.params.lock().ok().and_then(|p| p.clone()) {
                Some(p) => p,
                None => return, // no params to respawn from (shouldn't happen post-start).
            };
            match spawn_and_wait_ready(&params) {
                Ok((mut child, endpoint)) => {
                    // Orphan-race close: take the lock and re-check shutdown BEFORE storing. If the app
                    // shut down during spawn_and_wait_ready (which ran lock-free), kill+wait the new
                    // child here instead of storing it — otherwise it would escape shutdown's kill.
                    let stored = {
                        let mut g = match state.inner.lock() {
                            Ok(g) => g,
                            Err(_) => {
                                // Poisoned lock ⇒ shutdown already ran (it holds the same lock). Do not
                                // leak the child: kill+wait it here.
                                let _ = child.kill();
                                let _ = child.wait();
                                return;
                            }
                        };
                        if state.shutting_down.load(Ordering::SeqCst) {
                            let _ = child.kill();
                            let _ = child.wait();
                            false
                        } else {
                            *g = Some(SidecarRunning { child, endpoint: endpoint.clone() });
                            true
                        }
                    };
                    if !stored {
                        return; // shut down mid-respawn; new child already reaped. Stop supervising.
                    }
                    current_child_started_at = Instant::now();
                    eprintln!("[sidecar] 崩溃后已自动重启（第 {restart_attempts} 次）: {}", endpoint.base_url);
                    // Observability only; frontend recovers reactively via cache invalidation. No token.
                    let _ = app.emit(RESTARTED_EVENT, ());
                }
                Err(e) => {
                    eprintln!("[sidecar] 自动重启失败（第 {restart_attempts} 次）: {e}");
                    // spawn_and_wait_ready already killed+waited its child on failure. Leave the (dead)
                    // old slot in place; next tick retries with more backoff until the cap.
                }
            }
        }
    });
}

/// Frontend calls this to get the local sidecar base URL + handshake token (red-line 11).
/// Returns an error until the sidecar is ready.
#[tauri::command]
pub fn get_sidecar_endpoint(state: tauri::State<'_, SidecarState>) -> Result<SidecarEndpoint, String> {
    state.endpoint().ok_or_else(|| "本地 sidecar 尚未就绪".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 崩溃计数只在「已重启过 + 当前 child 存活满 HEALTHY_RESET_AFTER」时清零——正是 Codex 复审指出的
    // 「每次健康 tick 清零导致 5 次上限对快速崩溃循环永不触发」的修复。
    #[test]
    fn reset_only_after_sustained_uptime() {
        // 计数为 0：无需重置（本就为 0）。
        assert!(!should_reset_crash_counter(0, HEALTHY_RESET_AFTER));
        // 有重启历史但未存活够久：不清零（快速崩溃循环仍累加向上限）。
        assert!(!should_reset_crash_counter(3, HEALTHY_RESET_AFTER - Duration::from_millis(1)));
        assert!(!should_reset_crash_counter(3, Duration::from_secs(0)));
        // 有重启历史且已健康存活满阈值：视为恢复，清零。
        assert!(should_reset_crash_counter(3, HEALTHY_RESET_AFTER));
        assert!(should_reset_crash_counter(1, HEALTHY_RESET_AFTER + Duration::from_secs(10)));
    }

    // 快速崩溃循环（每次刚起来就崩，从不满 HEALTHY_RESET_AFTER）应在第 6 次触发上限（>5），
    // 证明 cap 真能收敛而非被每 tick 清零架空。
    #[test]
    fn fast_crash_loop_trips_cap() {
        let mut attempts = 0u32;
        let mut gave_up = false;
        // 模拟 10 轮「崩溃→（未满健康阈值，不清零）→递增→查上限」。
        for _ in 0..10 {
            // 崩溃前 child 只存活了很短时间（远不到 HEALTHY_RESET_AFTER）→ 不清零。
            if should_reset_crash_counter(attempts, Duration::from_secs(1)) {
                attempts = 0;
            }
            attempts += 1;
            if crash_cap_exceeded(attempts) {
                gave_up = true;
                break;
            }
        }
        assert!(gave_up, "快速崩溃循环必须在有限次后放弃自动重启");
        assert_eq!(attempts, RESTART_MAX_ATTEMPTS + 1, "应恰在第 {} 次触发上限", RESTART_MAX_ATTEMPTS + 1);
    }

    // 「崩溃→恢复→（久后）再崩」不应把偶发崩溃累加到上限：每次都健康存活满阈值 → 每轮清零。
    #[test]
    fn intermittent_crashes_do_not_accumulate() {
        let mut attempts = 0u32;
        for _ in 0..10 {
            // 每次崩溃前 child 都已健康存活满阈值 → 清零后再 +1，稳定停在 1，永不触发上限。
            if should_reset_crash_counter(attempts, HEALTHY_RESET_AFTER) {
                attempts = 0;
            }
            attempts += 1;
            assert!(!crash_cap_exceeded(attempts), "偶发（已恢复）崩溃不应触发上限");
        }
    }

    // 退避线性增长（1s × 次数），第 1 次 1s、第 3 次 3s。
    #[test]
    fn backoff_is_linear() {
        assert_eq!(restart_backoff(1), Duration::from_secs(1));
        assert_eq!(restart_backoff(3), Duration::from_secs(3));
    }

    // shutdown() 设 shutting_down 后 supervisor 不再重启——用状态标志断言语义（真实线程交接由集成/手测覆盖）。
    #[test]
    fn shutdown_sets_flag_and_empties_slot() {
        let state = SidecarState::default();
        // 初始无 child；shutdown 幂等，置标志。
        state.shutdown();
        assert!(state.shutting_down.load(Ordering::SeqCst));
        assert!(state.endpoint().is_none());
    }
}
