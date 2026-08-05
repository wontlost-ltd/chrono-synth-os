mod commands;
mod db;
mod sidecar;
mod tray;

use std::sync::Mutex;

use commands::app_settings::{get_app_setting, set_app_setting};
use commands::credentials::{clear_api_token, get_api_token, set_api_token};
use commands::crdt::{
    crdt_apply_local_field_update, crdt_apply_remote_update, crdt_export_full_state,
    crdt_get_persona_state,
};
use commands::database::open_database;
use commands::memories::{delete_memory, query_memories, upsert_memories};
use commands::personas::{query_personas, upsert_personas};
use commands::snapshots::{count_snapshots, query_snapshots, upsert_snapshots};
use commands::sync::{
    complete_sync, enqueue_offline_op, flush_offline_queue, force_sync, get_sync_state,
    mark_sync_failed, mark_sync_local,
};
use rusqlite::Connection;
use sidecar::{get_sidecar_endpoint, SidecarState};
use tauri::Manager;
use tray::{set_tray_status, TrayStatusState};

pub struct AppState {
    pub db: Mutex<Option<Connection>>,
    /* Populated when keyring backend init fails (e.g. Linux without an
     * active Secret Service). Commands that need secure storage check
     * this first and surface a controlled error instead of letting
     * Entry::new fail deeper in the call stack with a less actionable message. */
    pub keyring_init_error: Option<String>,
}

impl AppState {
    fn new(keyring_init_error: Option<String>) -> Self {
        Self {
            db: Mutex::new(None),
            keyring_init_error,
        }
    }
}

fn main() {
    /* keyring 4 requires explicit backend selection at startup. use_native_store(true)
     * picks macOS Keychain / Windows Credential Manager / Linux Secret Service automatically
     * (the `true` skips kernel-keyutils on Linux, which only persists per login session).
     *
     * Init failure is captured (not panicked) so the app still launches and the UI can
     * surface a clear "secure storage unavailable" error when the user tries to open
     * the encrypted database. Plaintext fallback is intentionally not provided. */
    let keyring_init_error = keyring::use_native_store(true)
        .err()
        .map(|e| format!("failed to initialize platform keyring backend: {e}"));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new(keyring_init_error))
        .manage(TrayStatusState::default())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            open_database,
            set_api_token,
            get_api_token,
            clear_api_token,
            query_personas,
            upsert_personas,
            query_memories,
            upsert_memories,
            delete_memory,
            get_sync_state,
            force_sync,
            complete_sync,
            mark_sync_failed,
            mark_sync_local,
            enqueue_offline_op,
            flush_offline_queue,
            crdt_apply_local_field_update,
            crdt_apply_remote_update,
            crdt_get_persona_state,
            crdt_export_full_state,
            get_app_setting,
            set_app_setting,
            set_tray_status,
            upsert_snapshots,
            query_snapshots,
            count_snapshots,
            get_sidecar_endpoint,
        ])
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            /* ADR-0061 S2：拉起本地 Node OS sidecar（spawn + 读 ready + 健康 + 握手 token）。
             * 失败不阻塞窗口启动——前端 get_sidecar_endpoint 会拿到错误并展示「本地引擎启动失败」。
             * dev（无打包 resources/sidecar）下 start 会返回入口不存在错误，属预期（S4 打包后随附）。 */
            let handle = app.handle().clone();
            let state = app.state::<SidecarState>();
            match sidecar::start_sidecar(&handle, &state) {
                Ok(ep) => {
                    /* 绝不打印 handshake_token（红线 11：不写日志）；只记端口用于排障。 */
                    eprintln!("[sidecar] 本地 OS 已就绪: {}", ep.base_url);
                }
                Err(e) => eprintln!("[sidecar] 启动失败（前端将提示）: {e}"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            /* 红线 4：窗口关闭 → 关停 sidecar，不留孤儿进程。 */
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<SidecarState>().shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run ChronoSynth desktop");
}
