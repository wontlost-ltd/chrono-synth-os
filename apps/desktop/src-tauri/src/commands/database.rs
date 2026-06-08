use std::fs;
use std::sync::Mutex;

use anyhow::{Context, Result};
use keyring_core::{Entry, Error as KeyringError};
use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::{db::run_migrations, AppState};

const KEYRING_SERVICE: &str = "chrono-synth-desktop";
const DB_KEYRING_USER: &str = "chrono-desktop-db-key";

/* Serializes the read-then-create sequence in load_or_create_database_key.
 * Without this, two concurrent open_database invocations on a fresh install
 * could both observe NoEntry, generate different keys, and the loser's key
 * gets overwritten — leaving its caller with a key that no longer decrypts
 * the database. Single-process Mutex is enough; the keychain itself is the
 * source of truth across processes. */
static DB_KEY_INIT: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn open_database(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    open_database_inner(app, state).map_err(|e| e.to_string())
}

fn open_database_inner(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve app data directory")?;

    fs::create_dir_all(&app_data_dir).with_context(|| {
        format!(
            "failed to create app data directory: {}",
            app_data_dir.display()
        )
    })?;

    let db_path = app_data_dir.join("chrono-synth.db");

    if let Some(err) = state.keyring_init_error.as_deref() {
        anyhow::bail!(
            "secure credential storage unavailable; cannot open encrypted database: {err}"
        );
    }

    let db_key = load_or_create_database_key()?;
    let conn = Connection::open(&db_path)
        .with_context(|| format!("failed to open database: {}", db_path.display()))?;

    apply_sqlcipher_key(&conn, &db_key)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    run_migrations(&conn)?;

    let mut guard = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("database lock poisoned"))?;
    *guard = Some(conn);

    Ok(())
}

fn load_or_create_database_key() -> Result<String> {
    let _guard = DB_KEY_INIT
        .lock()
        .map_err(|_| anyhow::anyhow!("db-key init lock poisoned"))?;
    let entry = Entry::new(KEYRING_SERVICE, DB_KEYRING_USER)?;

    match entry.get_password() {
        Ok(existing) if !existing.is_empty() => Ok(existing),
        Ok(_) => anyhow::bail!("stored database key is empty — keyring entry may be corrupted"),
        Err(KeyringError::NoEntry) => {
            let generated = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
            entry.set_password(&generated)?;
            Ok(generated)
        }
        Err(e) => Err(e).context("failed to read database key from keyring"),
    }
}

fn apply_sqlcipher_key(conn: &Connection, key: &str) -> Result<()> {
    let escaped = key.replace('\'', "''");
    conn.execute_batch(&format!("PRAGMA key = '{}';", escaped))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
    Ok(())
}
