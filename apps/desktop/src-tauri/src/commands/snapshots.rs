//! 本地 snapshots 命令（ADR-0046 路线 A）。
//!
//! 同步引擎从服务端 GET /api/v1/snapshots/:id 拉到快照原始数据后，用 `upsert_snapshots` 落到本地
//! `snapshots` 表（v008）。`query_snapshots` 返回最近两条（与服务端 PersonaDriftAnalyzer 的查询形状
//! 一致），前端用共享纯函数 computeDriftFromSnapshots 本地算 drift（真离线）。`count_snapshots`
//! 给「是否有可对比基线」判断（≥2）。

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

/// 本地快照行（镜像服务端 snapshots 子集）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRow {
    pub id: String,
    pub data_json: String,
    #[serde(default)]
    pub reason: String,
    /// 可空：NULL 当作 'default' 租户（与服务端 analyzer 查询语义一致）。
    #[serde(default)]
    pub tenant_id: Option<String>,
    pub created_at: i64,
    #[serde(default)]
    pub synced_at: i64,
}

/* 命令体抽成接收 &Connection / &mut Connection 的内部函数，便于直接 cargo 测试
 * （#[tauri::command] 的 State<AppState> 在单测里难构造）。命令只做 lock + 委托。 */

/// 幂等 upsert（事务）。内部函数，便于测试直接传 Connection。
pub fn upsert_snapshots_tx(conn: &mut rusqlite::Connection, snapshots: &[SnapshotRow]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for snap in snapshots {
        tx.execute(
            r#"
            INSERT INTO snapshots (id, data_json, reason, tenant_id, created_at, synced_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                data_json  = excluded.data_json,
                reason     = excluded.reason,
                tenant_id  = excluded.tenant_id,
                created_at = excluded.created_at,
                synced_at  = excluded.synced_at
            "#,
            params![
                snap.id,
                snap.data_json,
                snap.reason,
                snap.tenant_id,
                snap.created_at,
                snap.synced_at,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 落本地快照（幂等 upsert）。同步引擎拉到服务端快照数据后调用。
#[tauri::command]
pub async fn upsert_snapshots(
    state: State<'_, AppState>,
    snapshots: Vec<SnapshotRow>,
) -> Result<(), String> {
    let mut guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "database is not open".to_string())?;
    upsert_snapshots_tx(conn, &snapshots)
}

/// 取某租户最近两条快照（内部函数）。tenant None → "default"。
pub fn query_snapshots_conn(
    conn: &rusqlite::Connection,
    tenant_id: Option<&str>,
) -> Result<Vec<SnapshotRow>, String> {
    let tenant = tenant_id.unwrap_or("default");
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, data_json, reason, tenant_id, created_at, synced_at
              FROM snapshots
             WHERE tenant_id = ?1 OR (tenant_id IS NULL AND ?1 = 'default')
             ORDER BY created_at DESC
             LIMIT 2
            "#,
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![tenant], |row| {
            Ok(SnapshotRow {
                id: row.get(0)?,
                data_json: row.get(1)?,
                reason: row.get(2)?,
                tenant_id: row.get(3)?,
                created_at: row.get(4)?,
                synced_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 返回某租户最近两条快照（current + baseline），与服务端 analyzer 查询形状一致。
#[tauri::command]
pub async fn query_snapshots(
    state: State<'_, AppState>,
    tenant_id: Option<String>,
) -> Result<Vec<SnapshotRow>, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;
    query_snapshots_conn(conn, tenant_id.as_deref())
}

/// 某租户快照数量（内部函数）。tenant None → "default"。
pub fn count_snapshots_conn(conn: &rusqlite::Connection, tenant_id: Option<&str>) -> Result<i64, String> {
    let tenant = tenant_id.unwrap_or("default");
    conn.query_row(
        r#"
        SELECT COUNT(*) FROM snapshots
         WHERE tenant_id = ?1 OR (tenant_id IS NULL AND ?1 = 'default')
        "#,
        params![tenant],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// 某租户快照数量（用于「是否有可对比基线」判断，≥2 才算）。
#[tauri::command]
pub async fn count_snapshots(
    state: State<'_, AppState>,
    tenant_id: Option<String>,
) -> Result<i64, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;
    count_snapshots_conn(conn, tenant_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    use crate::db::migrations::run_migrations;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn row(id: &str, tenant: Option<&str>, created_at: i64, data: &str) -> SnapshotRow {
        SnapshotRow {
            id: id.to_string(),
            data_json: data.to_string(),
            reason: "test".to_string(),
            tenant_id: tenant.map(|s| s.to_string()),
            created_at,
            synced_at: 0,
        }
    }

    #[test]
    fn empty_db_returns_empty_and_zero() {
        let conn = open();
        assert_eq!(query_snapshots_conn(&conn, None).unwrap().len(), 0);
        assert_eq!(count_snapshots_conn(&conn, None).unwrap(), 0);
    }

    #[test]
    fn upsert_inserts_then_updates_same_id() {
        let mut conn = open();
        upsert_snapshots_tx(&mut conn, &[row("a", Some("default"), 100, "{\"v\":1}")]).unwrap();
        assert_eq!(count_snapshots_conn(&conn, None).unwrap(), 1);
        // 同 id 再 upsert → 更新而非新增。
        upsert_snapshots_tx(&mut conn, &[row("a", Some("default"), 150, "{\"v\":2}")]).unwrap();
        assert_eq!(count_snapshots_conn(&conn, None).unwrap(), 1, "same id updates, not inserts");
        let got = query_snapshots_conn(&conn, None).unwrap();
        assert_eq!(got[0].data_json, "{\"v\":2}", "data_json updated");
        assert_eq!(got[0].created_at, 150);
    }

    #[test]
    fn query_returns_latest_two_of_tenant_via_command_fn() {
        let mut conn = open();
        upsert_snapshots_tx(
            &mut conn,
            &[
                row("a", Some("default"), 100, "{}"),
                row("b", Some("default"), 300, "{}"),
                row("c", None, 200, "{}"), // NULL 当 default
                row("other", Some("tenantX"), 999, "{}"),
            ],
        )
        .unwrap();

        let ids: Vec<String> = query_snapshots_conn(&conn, None)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["b".to_string(), "c".to_string()], "latest two, NULL==default, excl tenantX");
    }

    #[test]
    fn none_equals_default_and_explicit_tenant_excludes_null() {
        let mut conn = open();
        upsert_snapshots_tx(
            &mut conn,
            &[
                row("d", Some("default"), 100, "{}"),
                row("n", None, 200, "{}"),
                row("x", Some("tenantX"), 300, "{}"),
            ],
        )
        .unwrap();

        // None → "default"：匹配 default + NULL = 2。
        assert_eq!(count_snapshots_conn(&conn, None).unwrap(), 2);
        assert_eq!(count_snapshots_conn(&conn, Some("default")).unwrap(), 2);
        // 显式非 default 租户：只匹配自己，不匹配 NULL。
        assert_eq!(count_snapshots_conn(&conn, Some("tenantX")).unwrap(), 1);
    }
}
