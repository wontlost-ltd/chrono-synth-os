mod commands;
mod db;
mod tray;

use std::sync::Mutex;

use commands::app_settings::{get_app_setting, set_app_setting};
use commands::crdt::{
    crdt_apply_local_field_update, crdt_apply_remote_update, crdt_export_full_state,
    crdt_get_persona_state,
};
use commands::database::open_database;
use commands::memories::{delete_memory, query_memories, upsert_memories};
use commands::personas::{query_personas, upsert_personas};
use commands::sync::{
    complete_sync, enqueue_offline_op, flush_offline_queue, force_sync, get_sync_state,
    mark_sync_failed,
};
use rusqlite::Connection;

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
        .invoke_handler(tauri::generate_handler![
            open_database,
            query_personas,
            upsert_personas,
            query_memories,
            upsert_memories,
            delete_memory,
            get_sync_state,
            force_sync,
            complete_sync,
            mark_sync_failed,
            enqueue_offline_op,
            flush_offline_queue,
            crdt_apply_local_field_update,
            crdt_apply_remote_update,
            crdt_get_persona_state,
            crdt_export_full_state,
            get_app_setting,
            set_app_setting,
        ])
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run ChronoSynth desktop");
}
