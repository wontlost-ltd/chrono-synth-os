//! Local Node OS sidecar lifecycle (ADR-0061 S2).
//!
//! Spawns the bundled ChronoSynth Node server (`resources/sidecar/dist/main-desktop.js`) as a
//! child process, reads its stdout ready marker (`CHRONO_SIDECAR_READY {json}`) to capture the
//! dynamically-assigned loopback port + instanceNonce, health-checks `/readyz`, and exposes the
//! resolved endpoint + per-launch handshake token to the frontend.
//!
//! Red-lines (ADR-0061):
//!  - #2 loopback only: the sidecar binds 127.0.0.1:0 itself (main-desktop.ts); we only read the port.
//!  - #4 lifecycle bound to app: child killed on drop / app exit; no orphan.
//!  - #11 local caller binding: a per-launch random handshake token is generated here, passed to the
//!    sidecar via env `CHRONO_DESKTOP_SESSION` (server enforces it), and handed to the frontend via
//!    `get_sidecar_endpoint` so its requests carry `X-Chrono-Desktop-Session`. Token never logged.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Resolved sidecar endpoint handed to the frontend. `handshakeToken` MUST accompany every
/// non-public request as `X-Chrono-Desktop-Session` (red-line 11).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEndpoint {
    pub base_url: String,
    pub handshake_token: String,
    pub instance_nonce: String,
}

/// Managed sidecar state. Child is kept so Drop / explicit shutdown can kill it (red-line 4).
pub struct SidecarState {
    inner: Mutex<Option<SidecarRunning>>,
}

struct SidecarRunning {
    child: Child,
    endpoint: SidecarEndpoint,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

impl SidecarState {
    /// Endpoint for the frontend (None until started).
    pub fn endpoint(&self) -> Option<SidecarEndpoint> {
        self.inner.lock().ok().and_then(|g| g.as_ref().map(|r| r.endpoint.clone()))
    }

    /// Graceful shutdown: kill the child (red-line 4, no orphan). Idempotent.
    pub fn shutdown(&self) {
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

/// Spawn + wait-ready the sidecar. Returns the resolved endpoint. Blocks until the ready marker
/// is seen (or timeout). Called once during app setup.
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

    // Red-line 11: per-launch handshake token (rotates every launch).
    let handshake = generate_handshake_token();

    // Red-line 5: JWT signing secret is a **persistent** local secret (NOT per-launch, else every restart
    // invalidates issued tokens). Generated once, stored in the platform keyring, reused thereafter —
    // never hardcoded, never in the install bundle. Distinct from the handshake token above.
    let jwt_secret = resolve_or_create_jwt_secret()?;

    // Prefer a bundled node (resources/node); fall back to PATH `node` (dev). S4 bundles node.
    let node_bin = {
        let bundled = resource_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        if bundled.exists() { bundled.into_os_string() } else { std::ffi::OsString::from("node") }
    };

    let mut child = Command::new(node_bin)
        .arg(&entry)
        .env("CHRONO_DB_DRIVER", "sqlite")
        .env("CHRONO_DB_PATH", &db_path)
        .env("CHRONO_QUEUE_ENABLED", "true")
        .env("CHRONO_JWT_ENABLED", "true")
        // Red-line 5: persistent JWT secret from keyring (issued tokens survive restarts).
        .env("CHRONO_JWT_SECRET", &jwt_secret)
        // Red-line 11: pass the handshake token; the server's desktop-session plugin enforces it.
        .env("CHRONO_DESKTOP_SESSION", &handshake)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("spawn sidecar: {e}"))?;

    // Read stdout for the ready marker on a **separate thread** and deliver via channel, so the
    // wait honours a **real hard timeout** — a blocking read_line inside a deadline loop would hang
    // forever if the child stays alive but emits no newline (Codex S2 复审 Major). The reader thread
    // is detached; it ends on marker/EOF/error. Token env is never logged here.
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => { let _ = child.kill(); let _ = child.wait(); return Err("no sidecar stdout".to_string()); }
    };
    let (tx, rx) = std::sync::mpsc::channel::<Option<ReadyMarker>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => { let _ = tx.send(None); break; } // EOF: exited before ready
                Ok(_) => {
                    if let Some(rest) = line.trim_end().strip_prefix(READY_PREFIX) {
                        let m = serde_json::from_str::<ReadyMarker>(rest).ok();
                        let _ = tx.send(m);
                        break;
                    }
                    // else: ordinary log line; keep reading.
                }
                Err(_) => { let _ = tx.send(None); break; }
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

    // Store child + endpoint so Drop/shutdown can kill it (red-line 4).
    if let Ok(mut g) = state.inner.lock() {
        *g = Some(SidecarRunning { child, endpoint: endpoint.clone() });
    }
    Ok(endpoint)
}

/// Frontend calls this to get the local sidecar base URL + handshake token (red-line 11).
/// Returns an error until the sidecar is ready.
#[tauri::command]
pub fn get_sidecar_endpoint(state: tauri::State<'_, SidecarState>) -> Result<SidecarEndpoint, String> {
    state.endpoint().ok_or_else(|| "本地 sidecar 尚未就绪".to_string())
}
