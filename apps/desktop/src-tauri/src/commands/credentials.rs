/*!
 * API 凭据的安全存储（审计 Critical 9）。
 *
 * 背景：桌面端此前把 JWT access token 明文写进 localStorage。桌面只加载本地打包资源
 * 且 CSP 为 `script-src 'self'`，没有远程 XSS 读取路径；真正的暴露面是**本地磁盘**——
 * localStorage 落在用户可读的应用数据目录，其它进程、备份、同步盘都能拿到明文令牌。
 *
 * 修法：token 改存 OS 平台密钥库（macOS Keychain / Windows Credential Manager /
 * Linux Secret Service），与既有 database.rs 的数据库密钥同款纪律：
 *   - 复用启动期捕获的 keyring_init_error，后端不可用时返回**可操作的错误**；
 *   - **绝不提供明文回退**——宁可让调用方拿到错误并要求重新登录，也不把令牌写回磁盘。
 */

use keyring_core::Entry;

use crate::AppState;

/* 与 sync.rs 同一 service 名，条目按 account 区分。 */
const KEYRING_SERVICE: &str = "chrono-synth-desktop";
/* API access token 的固定条目名（单账号桌面端）。 */
const API_TOKEN_ACCOUNT: &str = "api-access-token";

/** 构造 keyring 条目；后端不可用时返回可操作错误（不静默降级）。 */
fn token_entry(state: &AppState) -> Result<Entry, String> {
    if let Some(err) = state.keyring_init_error.as_deref() {
        return Err(format!(
            "安全存储不可用（{err}）。桌面端拒绝以明文保存登录令牌——\
             请确保系统密钥库可用（Linux 需运行中的 Secret Service）后重试。"
        ));
    }
    Entry::new(KEYRING_SERVICE, API_TOKEN_ACCOUNT)
        .map_err(|e| format!("无法访问系统密钥库: {e}"))
}

/** 写入 API access token。空串视为清除（与前端 setApiToken(null) 语义一致）。 */
#[tauri::command]
pub fn set_api_token(state: tauri::State<'_, AppState>, token: String) -> Result<(), String> {
    let entry = token_entry(&state)?;
    if token.is_empty() {
        /* NoEntry 不是错误：清除一个本就不存在的令牌是幂等成功。 */
        return match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("清除登录令牌失败: {e}")),
        };
    }
    entry
        .set_password(&token)
        .map_err(|e| format!("保存登录令牌失败: {e}"))
}

/** 读取 API access token；无令牌返回 None（未登录，非错误）。 */
#[tauri::command]
pub fn get_api_token(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let entry = token_entry(&state)?;
    match entry.get_password() {
        Ok(v) if !v.is_empty() => Ok(Some(v)),
        Ok(_) | Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取登录令牌失败: {e}")),
    }
}

/** 清除 API access token（登出）。 */
#[tauri::command]
pub fn clear_api_token(state: tauri::State<'_, AppState>) -> Result<(), String> {
    set_api_token(state, String::new())
}
