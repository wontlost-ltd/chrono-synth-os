use keyring_core::Entry;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

const KEYRING_SERVICE: &str = "chrono-synth-desktop";
const SERVER_URL_USER: &str = "chrono-desktop-server-url";
const ACCESS_TOKEN_USER: &str = "chrono-desktop-access-token";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStateRow {
    pub id: String,
    pub state: String,
    pub network_online: bool,
    pub auth_valid: bool,
    pub remote_reachable: bool,
    pub pending_push_count: i64,
    pub conflict_count: i64,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn get_sync_state(state: State<'_, AppState>) -> Result<SyncStateRow, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    conn.query_row(
        r#"
        SELECT
            id, state, network_online, auth_valid, remote_reachable,
            pending_push_count, conflict_count, last_sync_at, last_error, updated_at
        FROM sync_state
        WHERE id = 'singleton'
        "#,
        [],
        |row| {
            Ok(SyncStateRow {
                id: row.get(0)?,
                state: row.get(1)?,
                network_online: row.get(2)?,
                auth_valid: row.get(3)?,
                remote_reachable: row.get(4)?,
                pending_push_count: row.get(5)?,
                conflict_count: row.get(6)?,
                last_sync_at: row.get(7)?,
                last_error: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn force_sync(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    {
        let guard = state
            .db
            .lock()
            .map_err(|_| "database lock poisoned".to_string())?;
        let conn = guard
            .as_ref()
            .ok_or_else(|| "database is not open".to_string())?;

        /* ADR-0061：单机模式（state='local'）无远端可同步——强制同步是 no-op，绝不把 settled 的 `local`
         * 打回 `syncing`（进而 fetch 失败落 `degraded_remote`，把本地态污染成远端异常）。`WHERE ... AND
         * state != 'local'` 使更新影响 0 行；据此提前返回，跳过远端 fetch。前端也会禁用按钮（双重防护）。 */
        let changed = conn
            .execute(
                r#"
                UPDATE sync_state
                SET state = 'syncing',
                    last_error = NULL,
                    updated_at = unixepoch('now') * 1000
                WHERE id = 'singleton' AND state != 'local'
                "#,
                [],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Ok(());
        }
    }

    app.emit("sync://started", ()).map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = fetch_remote_personas().await;
        match result {
            Ok(body) => {
                let _ = app_handle.emit("sync://personas-fetched", body);
            }
            Err(e) => {
                let message = e.to_string().chars().take(500).collect::<String>();
                let state = app_handle.state::<crate::AppState>();
                if let Ok(guard) = state.db.lock() {
                    if let Some(conn) = guard.as_ref() {
                        let _ = conn.execute(
                            "UPDATE sync_state SET state='degraded_remote', last_error=?1, updated_at=unixepoch('now')*1000 WHERE id='singleton'",
                            rusqlite::params![message],
                        );
                    }
                }
                let _ = app_handle.emit("sync://failed", message);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn complete_sync(state: State<'_, AppState>, synced_at: i64) -> Result<(), String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    conn.execute(
        r#"
        UPDATE sync_state
        SET state = 'online_synced',
            last_sync_at = ?1,
            last_error = NULL,
            updated_at = unixepoch('now') * 1000
        WHERE id = 'singleton'
        "#,
        params![synced_at],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_sync_failed(state: State<'_, AppState>, error: String) -> Result<(), String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    conn.execute(
        r#"
        UPDATE sync_state
        SET state = 'degraded_remote',
            last_error = ?1,
            updated_at = unixepoch('now') * 1000
        WHERE id = 'singleton'
        "#,
        params![error],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// ADR-0061 S5/follow-up：单机模式（内嵌本地 sidecar，无远端后端）标 `local` 同步态——本地即真源，无远端可同步。
/// 修「本地一直卡 initial_sync/Syncing…」：初始 seed 是 `initial_sync`（等首次远端同步），但单机根本没有远端，
/// 会永久 syncing。前端确认本地 sidecar 模式后调本命令落 `local`。幂等：只从**未真正远端同步过**的态
/// （initial_sync）切到 local，不覆盖用户显式连远端后的 online_synced/degraded（远端模式共存）。
#[tauri::command]
pub async fn mark_sync_local(state: State<'_, AppState>) -> Result<(), String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let changed = mark_sync_local_sql(conn).map_err(|e| e.to_string())?;
    // 观测面包屑：单机同步态落定。changed=1 表示本次从 initial_sync 切到 local（首次自愈）；
    // changed=0 表示已是 local 或处于远端态（幂等 no-op）。不含敏感信息。
    eprintln!("[sync] mark_sync_local: rows_changed={changed}（1=已落定 local，0=已就位/远端态）");
    Ok(())
}

/// 执行「单机同步态落定」的实际 SQL：仅从 `initial_sync` 切到 `local`（幂等，不覆盖远端
/// online_synced/degraded_remote）。返回受影响行数（1=本次切换，0=已就位/远端态）。抽出便于
/// 用真实迁移后的 schema 做集成测试（rusqlite 单 Mutex 串行化，无并发问题）。
fn mark_sync_local_sql(conn: &rusqlite::Connection) -> rusqlite::Result<usize> {
    conn.execute(
        r#"
        UPDATE sync_state
        SET state = 'local',
            last_error = NULL,
            updated_at = unixepoch('now') * 1000
        WHERE id = 'singleton' AND state = 'initial_sync'
        "#,
        [],
    )
}

async fn fetch_remote_personas() -> anyhow::Result<serde_json::Value> {
    let server_url =
        keyring_value(SERVER_URL_USER).unwrap_or_else(|| "http://localhost:3000".to_string());
    let access_token = keyring_value(ACCESS_TOKEN_USER).unwrap_or_default();
    let url = format!("{}/api/v1/personas", server_url.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let mut request = client.get(url);

    if !access_token.is_empty() {
        request = request.bearer_auth(access_token);
    }

    let response = request.send().await?;
    let status = response.status();

    if !status.is_success() {
        anyhow::bail!("persona sync request failed with status {}", status);
    }

    Ok(response.json::<serde_json::Value>().await?)
}

fn keyring_value(user: &str) -> Option<String> {
    let entry = match Entry::new(KEYRING_SERVICE, user) {
        Ok(entry) => entry,
        Err(e) => {
            /* Backend unavailable or malformed default store. NoEntry only comes
             * from get_password, never from Entry::new, so any error here is
             * worth surfacing rather than silently treating as "no token". */
            eprintln!("keyring: failed to construct entry for user={user}: {e}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(v) if !v.is_empty() => Some(v),
        Ok(_) | Err(keyring_core::Error::NoEntry) => None,
        Err(e) => {
            eprintln!("keyring: failed to read password for user={user}: {e}");
            None
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// P3.4 — offline queue + LWW reconciliation
//
// Design: each user write goes to BOTH the local table AND offline_queue.
// On reconnect, flush_offline_queue() drains the queue, replaying writes
// against the server. The server applies its own LWW per row using
// `updated_at`; conflicts resolve to whichever side has the later
// timestamp. This is the simplest CRDT (LWW-Element-Set) and is sufficient
// for the desktop's "view + occasional edit" workload.
//
// True Yrs/Y.js operational transform is reserved for collaborative live
// editing (planned alongside P3.6 multi-region active-active); we don't
// need it for single-user-multi-device sync at this stage.
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineOp {
    pub id: String,
    pub operation: String,
    pub payload: serde_json::Value,
    pub created_at: i64,
    pub retry_count: i64,
}

/// Append an operation to the offline queue. The frontend calls this after
/// a successful local write so the change is replayable to the server on
/// next sync.
#[tauri::command]
pub async fn enqueue_offline_op(
    state: State<'_, AppState>,
    operation: String,
    payload: serde_json::Value,
) -> Result<String, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    if !is_known_operation(&operation) {
        return Err(format!("unknown offline operation: {}", operation));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let payload_text = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

    conn.execute(
        r#"
        INSERT INTO offline_queue (id, operation, payload)
        VALUES (?1, ?2, ?3)
        "#,
        rusqlite::params![id, operation, payload_text],
    )
    .map_err(|e| e.to_string())?;

    bump_pending_count(conn)?;

    Ok(id)
}

/// Drain the offline queue up to `max_batch_size` ops. The actual HTTP
/// dispatch is delegated to the frontend (which already speaks the os
/// REST API) — this command yields the queued ops in order and removes
/// them on success-acknowledged removal via `complete_offline_op`.
#[tauri::command]
pub async fn flush_offline_queue(
    state: State<'_, AppState>,
    max_batch_size: Option<i64>,
) -> Result<Vec<OfflineOp>, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let limit = max_batch_size.unwrap_or(50).clamp(1, 500);

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, operation, payload, created_at, retry_count
              FROM offline_queue
             ORDER BY created_at ASC
             LIMIT ?1
            "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([limit], |row| {
            let payload_text: String = row.get(2)?;
            let payload = serde_json::from_str::<serde_json::Value>(&payload_text)
                .unwrap_or(serde_json::Value::Null);
            Ok(OfflineOp {
                id: row.get(0)?,
                operation: row.get(1)?,
                payload,
                created_at: row.get(3)?,
                retry_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn is_known_operation(op: &str) -> bool {
    // 白名单：只接受我们认识的写操作。防止前端误投陌生 payload 进队列。
    matches!(
        op,
        "persona.upsert"
            | "persona.delete"
            | "memory.upsert"
            | "memory.delete"
            | "knowledge.upsert"
    )
}

fn bump_pending_count(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute(
        r#"
        UPDATE sync_state
           SET pending_push_count = pending_push_count + 1,
               updated_at = unixepoch('now') * 1000
         WHERE id = 'singleton'
        "#,
        [],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// LWW reconciliation: given a remote row with its updated_at, decide
/// whether to apply it locally. Returns true if the remote is newer than
/// the local row (or local row is absent), false if local is newer.
///
/// Pure function so it's unit-testable without a database fixture.
#[allow(dead_code)]
pub fn lww_should_apply_remote(local_updated_at: Option<i64>, remote_updated_at: i64) -> bool {
    match local_updated_at {
        None => true,
        Some(local) => remote_updated_at > local,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lww_remote_wins_when_local_missing() {
        assert!(lww_should_apply_remote(None, 100));
    }

    #[test]
    fn lww_remote_wins_when_remote_newer() {
        assert!(lww_should_apply_remote(Some(50), 100));
    }

    #[test]
    fn lww_local_wins_when_local_newer() {
        assert!(!lww_should_apply_remote(Some(150), 100));
    }

    #[test]
    fn lww_remote_wins_on_tie_is_false() {
        // Strict greater-than: ties go to local. Important for idempotent
        // re-syncs — if both sides have the same timestamp, no rewrite.
        assert!(!lww_should_apply_remote(Some(100), 100));
    }

    #[test]
    fn known_operations_accepted() {
        assert!(is_known_operation("persona.upsert"));
        assert!(is_known_operation("memory.delete"));
        assert!(!is_known_operation("rogue.command"));
        assert!(!is_known_operation(""));
    }

    // ── mark_sync_local：真实迁移后 schema 的端到端 DB 行为（修「永久 Syncing」的核心 SQL）──────
    use crate::db::migrations::run_migrations;
    use rusqlite::Connection;

    fn migrated_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn sync_state(conn: &Connection) -> String {
        conn.query_row("SELECT state FROM sync_state WHERE id='singleton'", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn fresh_db_seeds_initial_sync_and_marks_local() {
        // 迁移 seed 应是 initial_sync（正是「永久 Syncing」的来源）。
        let conn = migrated_db();
        assert_eq!(sync_state(&conn), "initial_sync", "迁移应 seed initial_sync");
        // mark_sync_local 把它切成 local，返回 1。
        assert_eq!(mark_sync_local_sql(&conn).unwrap(), 1);
        assert_eq!(sync_state(&conn), "local", "应落定为 local（不再 Syncing）");
    }

    #[test]
    fn mark_sync_local_is_idempotent() {
        // 第二次调用是 no-op（已是 local），返回 0，状态不变。
        let conn = migrated_db();
        assert_eq!(mark_sync_local_sql(&conn).unwrap(), 1);
        assert_eq!(mark_sync_local_sql(&conn).unwrap(), 0, "已 local → 幂等 no-op");
        assert_eq!(sync_state(&conn), "local");
    }

    #[test]
    fn mark_sync_local_does_not_clobber_remote_states() {
        // 远端模式：online_synced / degraded_remote 不应被标 local（WHERE state='initial_sync' 守卫）。
        for remote in ["online_synced", "degraded_remote", "syncing"] {
            let conn = migrated_db();
            conn.execute(
                "UPDATE sync_state SET state=?1 WHERE id='singleton'",
                [remote],
            )
            .unwrap();
            assert_eq!(mark_sync_local_sql(&conn).unwrap(), 0, "{remote} 不该被切");
            assert_eq!(sync_state(&conn), remote, "{remote} 应保持不变");
        }
    }
}
