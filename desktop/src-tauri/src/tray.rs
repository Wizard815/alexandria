//! The tray (menu bar on macOS) icon: Alexandria keeps running there when its window is
//! closed, so notifications (your turn, a quick event) still arrive. From the tray: open the
//! window, show the Assistant, keep running when closed, start with the computer, quit.
//! Started with the computer (`--minimized`), it starts in the tray.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

pub struct TrayItems {
    pub keep: CheckMenuItem<Wry>,
    pub login: CheckMenuItem<Wry>,
}

/// Show and focus the main window.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn build(app: &AppHandle, keep: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray_open", "Open Alexandria", true, None::<&str>)?;
    let assistant = MenuItem::with_id(app, "show_assistant", "Show Assistant", true, None::<&str>)?;
    let keep_item = CheckMenuItem::with_id(app, "tray_keep", "Keep running when the window is closed", true, keep, None::<&str>)?;
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let login_item = CheckMenuItem::with_id(app, "tray_login", "Start with the computer", true, at_login, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit Alexandria", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &assistant, &PredefinedMenuItem::separator(app)?, &keep_item, &login_item, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(TrayItems { keep: keep_item, login: login_item });
    let mut b = TrayIconBuilder::with_id("alexandria").tooltip("Alexandria").menu(&menu).show_menu_on_left_click(false).on_tray_icon_event(|tray, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            show_main(tray.app_handle());
        }
    });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

/// Tray menu clicks; returns true when the id was one of the tray's.
pub fn on_menu(app: &AppHandle, id: &str, set_keep: impl Fn(bool)) -> bool {
    match id {
        "tray_open" => show_main(app),
        "tray_quit" => app.exit(0),
        "tray_keep" => {
            let on = app.state::<TrayItems>().keep.is_checked().unwrap_or(true);
            set_keep(on);
        }
        "tray_login" => {
            let want = app.state::<TrayItems>().login.is_checked().unwrap_or(false);
            let al = app.autolaunch();
            let _ = if want { al.enable() } else { al.disable() };
            let _ = app.state::<TrayItems>().login.set_checked(al.is_enabled().unwrap_or(false));
        }
        _ => return false,
    }
    true
}

/// Started with the computer: stay in the tray until asked.
pub fn started_minimized() -> bool {
    std::env::args().any(|a| a == "--minimized")
}
