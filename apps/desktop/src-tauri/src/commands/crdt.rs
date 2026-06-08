//! P3.4 — Yrs CRDT for collaborative persona editing.
//!
//! 设计要点：
//! - 每个 persona 拥有独立的 Y.Doc，存储在 `crdt_state(persona_id, doc_state)` 表中。
//! - persona 的字段(display_name、status、visibility 等) 写入 root 的 YMap。
//! - 本地变更 → encode_state_as_update_v1 → 上送服务端；服务端将所有客户端的 update
//!   按 Yjs 协议合并，再下发给其他客户端。
//! - 字段级合并：两台设备同时修改不同字段时不会互相覆盖（这是 Yrs 相对 LWW 的关键优势）；
//!   同字段并发修改由 Yrs 内部 Lamport 时钟决定胜出方，与 LWW 行为一致但具备因果性。
//!
//! 外部接口：所有 Tauri 命令在更新 doc 后立刻把新的 state vector 持久化到 SQLite，
//! 这样应用重启后还能继续接受远端 update（Yrs 需要历史 state 来做因果合并）。

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use yrs::{
    updates::decoder::Decode, Doc, GetString, Map, MapRef, ReadTxn, StateVector, Transact, Update,
};

use crate::AppState;

/// 单个字段的可合并值。Yrs 支持任意 JSON 但桌面端只需要这三种。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum FieldValue {
    Text(String),
    Number(f64),
    Bool(bool),
}

impl FieldValue {
    fn to_yrs(&self) -> yrs::Any {
        match self {
            FieldValue::Text(s) => yrs::Any::String(s.clone().into()),
            FieldValue::Number(n) => yrs::Any::Number(*n),
            FieldValue::Bool(b) => yrs::Any::Bool(*b),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaFieldUpdate {
    pub persona_id: String,
    pub fields: HashMap<String, FieldValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrdtUpdatePayload {
    pub persona_id: String,
    /// Base64 编码的 Yrs update（v1 二进制协议）。
    pub update_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaCrdtState {
    pub persona_id: String,
    pub fields: HashMap<String, serde_json::Value>,
}

const ROOT_MAP: &str = "persona_fields";

/// 写入本地字段并返回需要上送服务端的 update（base64 编码）。
///
/// 调用方负责把返回的 `update_b64` 推到 offline_queue 或直接 POST 给 server。
#[tauri::command]
pub async fn crdt_apply_local_field_update(
    state: State<'_, AppState>,
    update: PersonaFieldUpdate,
) -> Result<CrdtUpdatePayload, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let doc = load_or_create_doc(conn, &update.persona_id)?;
    let map = doc.get_or_insert_map(ROOT_MAP);

    /* 每个事务都开在独立作用域内立即释放：yrs 0.21 在同 doc 同线程
     * 嵌套读写锁会死锁，必须严格串行。 */
    let state_vector_before = {
        let txn = doc.transact();
        txn.state_vector()
    };

    {
        let mut txn = doc.transact_mut();
        for (field, value) in update.fields.iter() {
            map.insert(&mut txn, field.clone(), value.to_yrs());
        }
    }

    /* 编码自上一个 state vector 起的增量 update — 这是用于跨设备同步的最小载荷。 */
    let update_bytes = {
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&state_vector_before)
    };

    persist_doc_state(conn, &update.persona_id, &doc)?;

    Ok(CrdtUpdatePayload {
        persona_id: update.persona_id,
        update_b64: BASE64.encode(update_bytes),
    })
}

/// 应用来自服务端的远端 update。Yrs 自动按因果顺序合并 — 本地未保存的 update 会被
/// 缓冲直到依赖到达。
#[tauri::command]
pub async fn crdt_apply_remote_update(
    state: State<'_, AppState>,
    payload: CrdtUpdatePayload,
) -> Result<PersonaCrdtState, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let update_bytes = BASE64
        .decode(&payload.update_b64)
        .map_err(|e| format!("invalid base64 update: {}", e))?;
    let update =
        Update::decode_v1(&update_bytes).map_err(|e| format!("invalid yrs update: {}", e))?;

    let doc = load_or_create_doc(conn, &payload.persona_id)?;
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(update)
            .map_err(|e| format!("apply update failed: {}", e))?;
    }

    persist_doc_state(conn, &payload.persona_id, &doc)?;

    Ok(snapshot_persona(&doc, payload.persona_id))
}

/// 读取当前 persona 的字段快照。前端在打开编辑器时调用一次，后续靠事件流增量更新。
#[tauri::command]
pub async fn crdt_get_persona_state(
    state: State<'_, AppState>,
    persona_id: String,
) -> Result<PersonaCrdtState, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let doc = load_or_create_doc(conn, &persona_id)?;
    Ok(snapshot_persona(&doc, persona_id))
}

/// 导出本地 doc 的完整 state — 用于初次连接时上传给新设备做基线。
#[tauri::command]
pub async fn crdt_export_full_state(
    state: State<'_, AppState>,
    persona_id: String,
) -> Result<CrdtUpdatePayload, String> {
    let guard = state
        .db
        .lock()
        .map_err(|_| "database lock poisoned".to_string())?;
    let conn = guard
        .as_ref()
        .ok_or_else(|| "database is not open".to_string())?;

    let doc = load_or_create_doc(conn, &persona_id)?;
    let bytes = {
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    };

    Ok(CrdtUpdatePayload {
        persona_id,
        update_b64: BASE64.encode(bytes),
    })
}

fn load_or_create_doc(conn: &Connection, persona_id: &str) -> Result<Doc, String> {
    let row: Option<Vec<u8>> = conn
        .query_row(
            "SELECT doc_state FROM crdt_state WHERE persona_id = ?1",
            params![persona_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let doc = Doc::new();
    if let Some(bytes) = row {
        let update = Update::decode_v1(&bytes)
            .map_err(|e| format!("corrupt crdt_state for {}: {}", persona_id, e))?;
        let mut txn = doc.transact_mut();
        txn.apply_update(update)
            .map_err(|e| format!("hydrate crdt_state failed: {}", e))?;
    }
    Ok(doc)
}

fn persist_doc_state(conn: &Connection, persona_id: &str, doc: &Doc) -> Result<(), String> {
    let bytes = {
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    };

    conn.execute(
        r#"
        INSERT INTO crdt_state (persona_id, doc_state, updated_at)
        VALUES (?1, ?2, unixepoch('now') * 1000)
        ON CONFLICT(persona_id) DO UPDATE SET
            doc_state = excluded.doc_state,
            updated_at = excluded.updated_at
        "#,
        params![persona_id, bytes],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn snapshot_persona(doc: &Doc, persona_id: String) -> PersonaCrdtState {
    /* 注意：必须先拿到 MapRef 再开事务。get_or_insert_map 在 root type 不存在
     * 时会自行 transact_mut，若当前已持有读事务会同线程死锁。 */
    let map: MapRef = doc.get_or_insert_map(ROOT_MAP);
    let txn = doc.transact();
    let mut fields = HashMap::new();
    for (key, value) in map.iter(&txn) {
        let json = match value {
            yrs::Out::Any(any) => any_to_json(&any),
            yrs::Out::YText(text) => serde_json::Value::String(text.get_string(&txn)),
            other => {
                serde_json::to_value(format!("{:?}", other)).unwrap_or(serde_json::Value::Null)
            }
        };
        fields.insert(key.to_string(), json);
    }
    PersonaCrdtState { persona_id, fields }
}

fn any_to_json(any: &yrs::Any) -> serde_json::Value {
    match any {
        yrs::Any::Null | yrs::Any::Undefined => serde_json::Value::Null,
        yrs::Any::Bool(b) => serde_json::Value::Bool(*b),
        yrs::Any::Number(n) => serde_json::Number::from_f64(*n)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        yrs::Any::BigInt(i) => serde_json::Value::Number((*i).into()),
        yrs::Any::String(s) => serde_json::Value::String(s.to_string()),
        yrs::Any::Buffer(b) => serde_json::Value::String(BASE64.encode(b.as_ref())),
        yrs::Any::Array(arr) => serde_json::Value::Array(arr.iter().map(any_to_json).collect()),
        yrs::Any::Map(m) => {
            let mut obj = serde_json::Map::new();
            for (k, v) in m.iter() {
                obj.insert(k.clone(), any_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations::run_migrations;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open mem db");
        run_migrations(&conn).expect("migrations apply");
        conn.execute(
            "INSERT INTO personas (persona_id, display_name, updated_at) VALUES ('p1', 'Alice', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn round_trip_field_update_persists() {
        let conn = setup_conn();

        let mut fields = HashMap::new();
        fields.insert(
            "display_name".to_string(),
            FieldValue::Text("Bob".to_string()),
        );
        fields.insert("growth_index".to_string(), FieldValue::Number(0.7));

        let doc = load_or_create_doc(&conn, "p1").unwrap();
        let map = doc.get_or_insert_map(ROOT_MAP);
        let sv = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            for (k, v) in &fields {
                map.insert(&mut txn, k.clone(), v.to_yrs());
            }
        }
        persist_doc_state(&conn, "p1", &doc).unwrap();

        let doc2 = load_or_create_doc(&conn, "p1").unwrap();
        let snap = snapshot_persona(&doc2, "p1".to_string());
        assert_eq!(
            snap.fields.get("display_name").unwrap(),
            &serde_json::json!("Bob")
        );
        assert_eq!(
            snap.fields.get("growth_index").unwrap(),
            &serde_json::json!(0.7)
        );

        let _ = sv;
    }

    #[test]
    fn concurrent_writes_to_different_fields_both_survive() {
        // 两台设备各自在白板上修改不同字段 — 经典 CRDT 正确性测试。
        // 关键：每个事务都开在独立作用域里立即释放，避免同 doc 嵌套读写锁。
        let doc_a = Doc::new();
        let doc_b = Doc::new();

        let map_a = doc_a.get_or_insert_map(ROOT_MAP);
        let map_b = doc_b.get_or_insert_map(ROOT_MAP);

        {
            let mut tx = doc_a.transact_mut();
            map_a.insert(&mut tx, "display_name", "Alice");
        }
        {
            let mut tx = doc_b.transact_mut();
            map_b.insert(&mut tx, "status", "active");
        }

        // 拿状态向量必须先把读事务释放再开下一个事务。
        let sv_b = {
            let tx = doc_b.transact();
            tx.state_vector()
        };
        let update_from_a = {
            let tx = doc_a.transact();
            tx.encode_state_as_update_v1(&sv_b)
        };
        {
            let mut tx = doc_b.transact_mut();
            tx.apply_update(Update::decode_v1(&update_from_a).unwrap())
                .unwrap();
        }

        let sv_a = {
            let tx = doc_a.transact();
            tx.state_vector()
        };
        let update_from_b = {
            let tx = doc_b.transact();
            tx.encode_state_as_update_v1(&sv_a)
        };
        {
            let mut tx = doc_a.transact_mut();
            tx.apply_update(Update::decode_v1(&update_from_b).unwrap())
                .unwrap();
        }

        let snap_a = snapshot_persona(&doc_a, "p1".into());
        let snap_b = snapshot_persona(&doc_b, "p1".into());

        // 两个字段都保留 — 这是 LWW 做不到的（LWW 整行覆盖）。
        assert_eq!(
            snap_a.fields.get("display_name").unwrap(),
            &serde_json::json!("Alice")
        );
        assert_eq!(
            snap_a.fields.get("status").unwrap(),
            &serde_json::json!("active")
        );
        assert_eq!(snap_b.fields, snap_a.fields, "convergence holds");
    }

    #[test]
    fn applying_corrupt_update_fails_loudly() {
        let conn = setup_conn();
        // 直接塞坏数据。
        conn.execute(
            "INSERT INTO crdt_state (persona_id, doc_state, updated_at) VALUES ('bad', X'DEADBEEF', 0)",
            [],
        )
        .unwrap();

        let result = load_or_create_doc(&conn, "bad");
        assert!(result.is_err(), "corrupt state vector must surface error");
    }

    #[test]
    fn missing_persona_creates_empty_doc() {
        let conn = setup_conn();
        let doc = load_or_create_doc(&conn, "never-seen").unwrap();
        let snap = snapshot_persona(&doc, "never-seen".to_string());
        assert!(snap.fields.is_empty(), "fresh doc has no fields");
    }
}
