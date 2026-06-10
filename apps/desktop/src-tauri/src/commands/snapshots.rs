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

/// 返回某租户最近两条快照（current + baseline），与服务端 analyzer 查询形状一致。
/// tenant 传 None / "default" 时也匹配 tenant_id IS NULL 的本地快照。
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

    let tenant = tenant_id.unwrap_or_else(|| "default".to_string());
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

    let tenant = tenant_id.unwrap_or_else(|| "default".to_string());
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

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use crate::db::migrations::run_migrations;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, tenant: Option<&str>, created_at: i64) {
        conn.execute(
            "INSERT INTO snapshots (id, data_json, reason, tenant_id, created_at)
             VALUES (?1, '{\"values\":[]}', '', ?2, ?3)",
            rusqlite::params![id, tenant, created_at],
        )
        .unwrap();
    }

    #[test]
    fn query_returns_latest_two_of_tenant() {
        let conn = open();
        insert(&conn, "a", Some("default"), 100);
        insert(&conn, "b", Some("default"), 300);
        insert(&conn, "c", None, 200); // NULL 当 default
        insert(&conn, "other", Some("tenantX"), 999);

        let mut stmt = conn
            .prepare(
                "SELECT id FROM snapshots
                  WHERE tenant_id = ?1 OR (tenant_id IS NULL AND ?1 = 'default')
                  ORDER BY created_at DESC LIMIT 2",
            )
            .unwrap();
        let ids: Vec<String> = stmt
            .query_map(["default"], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids, vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn count_excludes_other_tenants() {
        let conn = open();
        insert(&conn, "a", Some("default"), 100);
        insert(&conn, "c", None, 200);
        insert(&conn, "other", Some("tenantX"), 999);
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM snapshots
                  WHERE tenant_id = ?1 OR (tenant_id IS NULL AND ?1 = 'default')",
                ["default"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2, "default + NULL count; tenantX excluded");
    }
}
