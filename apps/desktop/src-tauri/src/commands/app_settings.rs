//! App-level settings stored in `app_settings` (kv) table.
//!
//! v007 introduced the table for first-launch onboarding flag tracking;
//! the same kv shape will absorb future settings (theme override,
//! telemetry opt-out, etc.). See `db/migrations.rs::v007_app_settings`
//! for schema rationale.

use rusqlite::params;
use tauri::State;

use crate::AppState;

/// Read a single setting. Returns `Ok(None)` for missing key — the caller
/// (frontend) decides what the absence semantics are. For onboarding,
/// missing = "never completed" = show first-launch flow.
#[tauri::command]
pub async fn get_app_setting(
    key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let result: Result<String, rusqlite::Error> = conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    );

    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("get_app_setting({key}): {e}")),
    }
}

/// Upsert a setting. Both key and value are caller-controlled; the table's
/// PK on `key` collapses repeated writes into the latest value.
#[tauri::command]
pub async fn set_app_setting(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?1, ?2, unixepoch('now') * 1000)
         ON CONFLICT(key) DO UPDATE
           SET value = excluded.value,
               updated_at = excluded.updated_at",
        params![key, value],
    )
    .map_err(|e| format!("set_app_setting({key}): {e}"))?;

    Ok(())
}
