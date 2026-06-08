//! Memory-graph commands.
//!
//! Mirrors a slim subset of chrono-synth-os's memory_nodes API: list,
//! upsert from server-fetched payloads, and delete-by-id. Edges are
//! out-of-scope for the desktop client today (the os server computes
//! them on read); we expose them in a future iteration once the local
//! cognitive cycle moves into Tauri-Rust.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryNodeRow {
    pub id: String,
    pub persona_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub valence: f64,
    pub salience: f64,
    pub created_at: i64,
    pub last_accessed_at: i64,
    pub synced_at: i64,
}

#[tauri::command]
pub async fn query_memories(
    state: State<'_, AppState>,
    persona_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MemoryNodeRow>, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let bound = limit.unwrap_or(200).clamp(1, 1000);

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, persona_id, kind, content, valence, salience,
                   created_at, last_accessed_at, synced_at
              FROM memory_nodes
             WHERE (?1 IS NULL OR persona_id = ?1)
             ORDER BY last_accessed_at DESC
             LIMIT ?2
            "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![persona_id, bound], |row| {
            Ok(MemoryNodeRow {
                id: row.get(0)?,
                persona_id: row.get(1)?,
                kind: row.get(2)?,
                content: row.get(3)?,
                valence: row.get(4)?,
                salience: row.get(5)?,
                created_at: row.get(6)?,
                last_accessed_at: row.get(7)?,
                synced_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert_memories(
    state: State<'_, AppState>,
    memories: Vec<MemoryNodeRow>,
) -> Result<(), String> {
    let mut guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "database is not open".to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for memory in memories {
        validate_memory(&memory)?;
        tx.execute(
            r#"
            INSERT INTO memory_nodes
                (id, persona_id, kind, content, valence, salience,
                 created_at, last_accessed_at, synced_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
                persona_id       = excluded.persona_id,
                kind             = excluded.kind,
                content          = excluded.content,
                valence          = excluded.valence,
                salience         = excluded.salience,
                last_accessed_at = excluded.last_accessed_at,
                synced_at        = excluded.synced_at
            "#,
            params![
                memory.id,
                memory.persona_id,
                memory.kind,
                memory.content,
                memory.valence,
                memory.salience,
                memory.created_at,
                memory.last_accessed_at,
                memory.synced_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_memory(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    conn.execute("DELETE FROM memory_nodes WHERE id = ?1", params![id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn validate_memory(m: &MemoryNodeRow) -> Result<(), String> {
    if m.id.trim().is_empty() {
        return Err("memory id is required".into());
    }
    if m.content.trim().is_empty() {
        return Err("memory content is required".into());
    }
    if !matches!(m.kind.as_str(), "episodic" | "semantic" | "procedural") {
        return Err(format!("invalid memory kind: {}", m.kind));
    }
    if !m.valence.is_finite() || m.valence < -1.0 || m.valence > 1.0 {
        return Err(format!("valence must be in [-1, 1]: {}", m.valence));
    }
    if !m.salience.is_finite() || m.salience < 0.0 || m.salience > 1.0 {
        return Err(format!("salience must be in [0, 1]: {}", m.salience));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::run_migrations;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn.execute(
            "INSERT INTO personas (persona_id, display_name, updated_at) VALUES ('p1', 'P', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn validation_rejects_out_of_range_valence() {
        let m = MemoryNodeRow {
            id: "m1".into(),
            persona_id: Some("p1".into()),
            kind: "episodic".into(),
            content: "x".into(),
            valence: 2.0,
            salience: 0.5,
            created_at: 0,
            last_accessed_at: 0,
            synced_at: 0,
        };
        assert!(validate_memory(&m).is_err());
    }

    #[test]
    fn validation_rejects_unknown_kind() {
        let m = MemoryNodeRow {
            id: "m1".into(),
            persona_id: Some("p1".into()),
            kind: "speculative".into(),
            content: "x".into(),
            valence: 0.0,
            salience: 0.5,
            created_at: 0,
            last_accessed_at: 0,
            synced_at: 0,
        };
        assert!(validate_memory(&m).is_err());
    }

    #[test]
    fn upsert_then_query_round_trips() {
        let conn = fresh();
        let m = MemoryNodeRow {
            id: "m1".into(),
            persona_id: Some("p1".into()),
            kind: "episodic".into(),
            content: "first".into(),
            valence: 0.2,
            salience: 0.7,
            created_at: 100,
            last_accessed_at: 200,
            synced_at: 300,
        };
        validate_memory(&m).unwrap();
        conn.execute(
            r#"INSERT INTO memory_nodes (id, persona_id, kind, content, valence, salience, created_at, last_accessed_at, synced_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
            params![m.id, m.persona_id, m.kind, m.content, m.valence, m.salience, m.created_at, m.last_accessed_at, m.synced_at],
        )
        .unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_nodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
