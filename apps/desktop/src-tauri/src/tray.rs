//! 系统托盘（ADR-0046 Phase 2.4b）：菜单 + 动态「数字人状态」项。
//!
//! 状态项的**文案由前端合成**（TS `computeTrayStatusLabel`：本地 drift alertLevel + sync 在线/离线
//! → 成长中/探索活跃/需关注/离线），通过 `set_tray_status` 命令推进来。这里只负责：建一个禁用的状态
//! 菜单项、持有它的句柄、暴露更新文本的命令。Rust 不重复 TS 的合成逻辑（单一事实来源在 TS，可 vitest）。

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, Wry};

/// 持有可动态更新文本的「数字人状态」菜单项句柄。
///
/// `setup_tray` 建好后存进来；`set_tray_status` 命令据此 `set_text`。用 Mutex 包裹是因为 Tauri 命令
/// 在多线程运行时被调用，需内部可变 + Send/Sync。初始为 None（tray 尚未 setup 时命令优雅 no-op）。
#[derive(Default)]
pub struct TrayStatusState {
    pub item: Mutex<Option<MenuItem<Wry>>>,
}

/// 状态项初始文案（前端首次 push 之前显示）。
const INITIAL_STATUS_LABEL: &str = "⚪ 数字人：…";

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    /* 状态项禁用（enabled=false）：它是只读指示，不可点击。放在菜单最上方。 */
    let status = MenuItem::with_id(app, "status", INITIAL_STATUS_LABEL, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let force_sync = MenuItem::with_id(app, "force_sync", "Force Sync", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &open, &force_sync, &quit])?;

    /* 句柄存入 state，供 set_tray_status 后续更新文本。 */
    if let Some(state) = app.try_state::<TrayStatusState>() {
        *state.item.lock().unwrap() = Some(status);
    }

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "force_sync" => {
                let _ = app.emit("sync://force-requested", ());
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// 更新托盘「数字人状态」菜单项文本。
///
/// 文案由前端 `computeTrayStatusLabel` 合成后传入（含状态点 emoji + 中文）。tray 尚未 setup 或句柄
/// 缺失时优雅 no-op（不报错）——前端轮询会再次推送。
#[tauri::command]
pub async fn set_tray_status(
    label: String,
    state: State<'_, TrayStatusState>,
) -> Result<(), String> {
    let guard = state
        .item
        .lock()
        .map_err(|_| "tray status lock poisoned".to_string())?;
    if let Some(item) = guard.as_ref() {
        item.set_text(label).map_err(|e| format!("set_tray_status: {e}"))?;
    }
    Ok(())
}
