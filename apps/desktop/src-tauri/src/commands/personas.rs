use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaRow {
    pub persona_id: String,
    pub display_name: String,
    pub status: String,
    pub visibility: String,
    pub growth_index: f64,
    pub reputation: f64,
    pub wallet_id: Option<String>,
    pub wallet_balance: Option<f64>,
    pub updated_at: String,
    pub synced_at: i64,
}

#[tauri::command]
pub async fn query_personas(state: State<'_, AppState>) -> Result<Vec<PersonaRow>, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                persona_id,
                display_name,
                status,
                visibility,
                growth_index,
                reputation,
                wallet_id,
                wallet_balance,
                updated_at,
                synced_at
            FROM personas
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(PersonaRow {
                persona_id: row.get(0)?,
                display_name: row.get(1)?,
                status: row.get(2)?,
                visibility: row.get(3)?,
                growth_index: row.get(4)?,
                reputation: row.get(5)?,
                wallet_id: row.get(6)?,
                wallet_balance: row.get(7)?,
                updated_at: row.get(8)?,
                synced_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert_personas(
    state: State<'_, AppState>,
    personas: Vec<PersonaRow>,
) -> Result<(), String> {
    let mut guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "database is not open".to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for persona in personas {
        validate_persona(&persona)?;

        tx.execute(
            r#"
            INSERT INTO personas (
                persona_id, display_name, status, visibility,
                growth_index, reputation, wallet_id, wallet_balance,
                updated_at, synced_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(persona_id) DO UPDATE SET
                display_name   = excluded.display_name,
                status         = excluded.status,
                visibility     = excluded.visibility,
                growth_index   = excluded.growth_index,
                reputation     = excluded.reputation,
                wallet_id      = excluded.wallet_id,
                wallet_balance = excluded.wallet_balance,
                updated_at     = excluded.updated_at,
                synced_at      = excluded.synced_at
            "#,
            params![
                persona.persona_id,
                persona.display_name,
                persona.status,
                persona.visibility,
                persona.growth_index,
                persona.reputation,
                persona.wallet_id,
                persona.wallet_balance,
                persona.updated_at,
                persona.synced_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

fn validate_persona(persona: &PersonaRow) -> Result<(), String> {
    if persona.persona_id.trim().is_empty() {
        return Err("persona_id is required".to_string());
    }
    if persona.display_name.trim().is_empty() {
        return Err("display_name is required".to_string());
    }
    if !matches!(
        persona.status.as_str(),
        "active" | "inactive" | "restricted" | "deceased"
    ) {
        return Err(format!("invalid persona status: {}", persona.status));
    }
    if !matches!(persona.visibility.as_str(), "private" | "shared" | "public") {
        return Err(format!(
            "invalid persona visibility: {}",
            persona.visibility
        ));
    }
    if !persona.growth_index.is_finite() || !persona.reputation.is_finite() {
        return Err("persona numeric fields must be finite".to_string());
    }
    Ok(())
}
