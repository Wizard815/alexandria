//! Alexandria desktop: the web app in a native window pointed at the user's
//! server, plus a separate Assistant window (optionally always on top) that a
//! global shortcut shows and focuses.
//!
//! The web app and the assistant window are remote pages. They are given no
//! access to this app (see capabilities/default.json): the menu, the shortcut
//! and the window handling are all done here in Rust, and sign-in is the web
//! app's own, exactly as in a browser.

#[cfg(desktop)]
mod tray;
mod update;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, Url, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri::Wry;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Shows and focuses the Assistant window from anywhere (Cmd on macOS).
#[cfg(desktop)]
const SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[derive(Default, Clone, Serialize, Deserialize)]
struct Settings {
    /// Origin of the Alexandria server, e.g. "https://alexandria.example.com".
    server: Option<String>,
    /// Slug of the world last open in the main window, for the Assistant.
    last_world: Option<String>,
    assistant_on_top: bool,
    /// Closing the window keeps Alexandria in the tray (default on), so notifications still come.
    #[serde(default)]
    keep_in_tray: Option<bool>,
}

struct State {
    settings: Mutex<Settings>,
    path: PathBuf,
}

#[cfg(desktop)]
struct OnTopItem(CheckMenuItem<Wry>);

impl State {
    fn load(path: PathBuf) -> Self {
        let settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        State { settings: Mutex::new(settings), path }
    }

    fn update(&self, f: impl FnOnce(&mut Settings)) {
        let mut s = self.settings.lock().unwrap();
        f(&mut s);
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&*s) {
            let _ = std::fs::write(&self.path, text);
        }
    }

    fn get(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
}

/// Where the bundled first-run screen lives, whatever the platform.
fn local_url(path: &str) -> Url {
    let base = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).and_then(|b| b.join(path)).expect("valid local url")
}

fn server_url(app: &AppHandle) -> Option<Url> {
    app.state::<State>().get().server.and_then(|s| Url::parse(&s).ok())
}

/// "/w/<slug>/..." gives the slug.
#[cfg(desktop)]
fn world_of(url: &Url) -> Option<String> {
    let mut seg = url.path_segments()?;
    (seg.next()? == "w").then(|| seg.next().filter(|s| !s.is_empty()).map(str::to_string))?
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

/// The main and assistant windows may show the local screen and the user's
/// server. Any other address opens in the system browser instead.
fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
    if matches!(url.scheme(), "tauri" | "about" | "data" | "blob") || url.host_str() == Some("tauri.localhost") {
        return true;
    }
    if server_url(app).is_some_and(|s| s.origin() == url.origin()) {
        if let Some(action) = url.path().strip_prefix("/app-link/") {
            app_link(app, action, url);
            return false;
        }
        return true;
    }
    open_external(url);
    false
}

/// What the widget reads (Android): the server, the world and a widget key that only opens that
/// world's glance (see librarian/src/features/glance). Lives next to settings.json, inside the
/// app's own data folder, which no other app can read.
fn widget_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("widget.json"))
}

fn forget_widget(app: &AppHandle) {
    if let Some(p) = widget_path(app) {
        let _ = std::fs::remove_file(p);
    }
}

/// `k=...&w=...` from a link's #fragment (never sent to the server). Keys are base64url and
/// slugs are lowercase letters, digits and dashes, so nothing here needs decoding; anything else
/// is refused.
fn fragment_value(url: &Url, name: &str) -> Option<String> {
    fragment_with(url, name, |c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A build's file name: letters, digits and `-_.+` (the server only serves names like that).
fn fragment_file(url: &Url, name: &str) -> Option<String> {
    fragment_with(url, name, |c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+')).filter(|v| !v.starts_with('.'))
}

fn fragment_with(url: &Url, name: &str, ok: impl Fn(char) -> bool) -> Option<String> {
    url.fragment()?
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty() && v.len() <= 200 && v.chars().all(ok))
}


fn invite_code_ok(c: &str) -> bool {
    !c.is_empty() && c.len() <= 64 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

/// An invite opened from outside: `alexandria://join?server=<origin>&code=<invite code>` (the
/// Join page's "Open in the app" button, or a QR code). On the saved server (or with none saved
/// yet) it opens the Join page there; for another server, the first-run screen asks first.
fn open_link(app: &AppHandle, link: &Url) {
    if link.scheme() != "alexandria" {
        return;
    }
    let q: std::collections::HashMap<String, String> = link.query_pairs().into_owned().collect();
    let what = link.host_str().unwrap_or_else(|| link.path().trim_matches('/'));
    if what != "join" {
        return;
    }
    let (Some(server), Some(code)) = (q.get("server"), q.get("code")) else { return };
    let Ok(s) = Url::parse(server) else { return };
    if !matches!(s.scheme(), "http" | "https") || s.host_str().is_none() || !invite_code_ok(code) {
        return;
    }
    let origin = s.origin().ascii_serialization();
    let saved = app.state::<State>().get().server;
    let Some(main) = app.get_webview_window("main") else { return };
    let target = if saved.is_none() || saved.as_deref() == Some(&origin) {
        if saved.is_none() {
            app.state::<State>().update(|st| st.server = Some(origin.clone()));
        }
        Url::parse(&format!("{origin}/join?code={code}")).ok()
    } else {
        let mut u = local_url("index.html");
        u.query_pairs_mut().append_pair("server", &origin).append_pair("code", code);
        Some(u)
    };
    if let Some(t) = target {
        let main2 = main.clone();
        std::thread::spawn(move || {
            let _ = main2.navigate(t);
            let _ = main2.show();
            let _ = main2.set_focus();
        });
    }
}

/// Free text the page sent percent-encoded (a notification's title or body), decoded.
fn fragment_text(url: &Url, name: &str) -> Option<String> {
    let raw = url.fragment()?.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == name)?.1;
    if raw.is_empty() || raw.len() > 1500 {
        return None;
    }
    let b = raw.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).ok()?, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// A page of the saved server asks the app for something by going to `/app-link/<action>`.
/// The navigation itself is always cancelled, and the page gets no other access to the app.
/// - `widget#k=<widget key>&w=<world slug>`: link the home-screen widget (Android).
/// - `widget-off`: unlink it.
/// - `change-server`: back to the first-run screen, to type another address.
/// - `notify#i=<id>&t=<title>&b=<body>&p=<path>`: a system notification (percent-encoded text).
/// - `recording#on=1|0`: Android keeps recording with the screen locked while on.
/// - `update#f=<file>&t=<ticket>&s=<sha256>`: download that build from the saved server
///   (`/api/apps/file/<file>?t=<ticket>`), check its SHA-256 and install it (see `update`).
/// A system notification. Android: written to notify.json for the Kotlin side (Notifier.kt),
/// which posts it and opens `path` when it is tapped. Desktop: the notification plugin.
#[cfg(target_os = "android")]
fn notify_os(app: &AppHandle, id: &str, title: &str, body: &str, path: Option<&str>, actions: Option<serde_json::Value>) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let tmp = dir.join("notify.json.tmp");
    let v = serde_json::json!({ "id": id, "title": title, "body": body, "path": path, "actions": actions });
    if std::fs::write(&tmp, v.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join("notify.json"));
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn notify_os(app: &AppHandle, _id: &str, title: &str, body: &str, _path: Option<&str>, _actions: Option<serde_json::Value>) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(target_os = "ios")]
fn notify_os(_app: &AppHandle, _id: &str, _title: &str, _body: &str, _path: Option<&str>, _actions: Option<serde_json::Value>) {}

fn app_link(app: &AppHandle, action: &str, url: &Url) {
    match action.trim_end_matches('/') {
        "update" => {
            let (Some(file), Some(ticket), Some(sha)) = (fragment_file(url, "f"), fragment_value(url, "t"), fragment_value(url, "s")) else {
                return;
            };
            let Some(mut src) = server_url(app) else { return };
            if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
                return;
            }
            src.set_path(&format!("/api/apps/file/{file}"));
            src.set_query(Some(&format!("t={ticket}")));
            update::start(app, src, file, sha.to_ascii_lowercase());
        }
        "widget" if cfg!(target_os = "android") => {
            let (Some(key), Some(world), Some(server)) = (fragment_value(url, "k"), fragment_value(url, "w"), app.state::<State>().get().server) else {
                return;
            };
            if !key.starts_with("alx_wdg_") {
                return;
            }
            let Some(path) = widget_path(app) else { return };
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let body = serde_json::json!({ "server": server, "world": world, "key": key });
            let _ = std::fs::write(&path, body.to_string());
        }
        "notify" => {
            // A notification the page asks for (src/features/apps/Notifier.tsx in web/): the
            // page shows each alert once; the app only shows it, trimmed, with no markup.
            let (Some(id), Some(title)) = (fragment_text(url, "i"), fragment_text(url, "t")) else {
                return;
            };
            let clip = |s: String, n: usize| s.chars().filter(|c| !c.is_control()).take(n).collect::<String>();
            let body = fragment_text(url, "b").map(|b| clip(b, 240)).unwrap_or_default();
            let path = fragment_text(url, "p").filter(|p| p.starts_with("/w/") && !p.contains("..") && !p.contains("//"));
            // Android: buttons to answer a quick event ([{id, label}] as JSON); checked on the Kotlin side.
            let actions = fragment_text(url, "a").and_then(|a| serde_json::from_str::<serde_json::Value>(&a).ok()).filter(|v| v.is_array());
            notify_os(app, &clip(id, 120), &clip(title, 80), &body, path.as_deref(), actions);
        }
        // Android: the page is recording as a table mic (or stopped); Recording.kt keeps it going
        // with the screen locked while recording.on exists.
        "recording" if cfg!(target_os = "android") => {
            let Ok(dir) = app.path().app_config_dir() else { return };
            let flag = dir.join("recording.on");
            if fragment_value(url, "on").as_deref() == Some("1") {
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(&flag, b"1");
            } else {
                let _ = std::fs::remove_file(&flag);
            }
        }
        "widget-off" => forget_widget(app),
        "change-server" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.navigate(local_url("index.html"));
                }
            });
        }
        _ => {}
    }
}

/// Microphone requests (dictation, recording, voice) are answered yes, but only for a page of the
/// user's own server. Camera, location and everything else from any page is refused, and any
/// other address gets no microphone. (Android also asks the person once, through the system.)
fn permission_for(app: &AppHandle, webview: &Webview, kind: PermissionKind) -> PermissionResponse {
    let ours = webview
        .url()
        .ok()
        .zip(server_url(app))
        .is_some_and(|(page, server)| page.origin() == server.origin());
    match kind {
        PermissionKind::Microphone if ours => PermissionResponse::Allow,
        PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::Geolocation | PermissionKind::DisplayCapture => {
            PermissionResponse::Deny
        }
        _ => PermissionResponse::Default,
    }
}

fn window_opener(#[allow(unused_variables)] app: &AppHandle, url: Url) {
    // The web app's "pop out" button calls window.open(.../assistant-window).
    #[cfg(desktop)]
    {
        let ours = server_url(app).is_some_and(|s| s.origin() == url.origin());
        if ours && url.path().ends_with("/assistant-window") {
            spawn_assistant(app, world_of(&url), false);
            return;
        } else if ours && url.path().ends_with("/screen/players") {
            spawn_players_screen(app, world_of(&url));
            return;
        }
    }
    open_external(&url);
}

/// Tells the web app which app it runs in, so it can offer this app's updates: version, platform
/// and processor. Nothing else is shared with the page.
fn app_info_script(app: &AppHandle) -> String {
    let platform = if cfg!(target_os = "android") { "android" } else if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" };
    let info = serde_json::json!({ "version": app.package_info().version.to_string(), "platform": platform, "arch": std::env::consts::ARCH });
    format!("Object.defineProperty(window, '__ALEXANDRIA_APP__', {{ value: Object.freeze({info}), configurable: false }});")
}

fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let url = match server_url(app) {
        Some(u) => WebviewUrl::External(u),
        None => WebviewUrl::App("index.html".into()),
    };
    let (nav, new, perm) = (app.clone(), app.clone(), app.clone());
    let builder = WebviewWindowBuilder::new(app, "main", url)
        .initialization_script(&app_info_script(app))
        .title("Alexandria")
        .on_navigation(move |u| allow_navigation(&nav, u))
        .on_permission_request(move |wv, kind| permission_for(&perm, &wv, kind))
        .on_new_window(move |u, _features| {
            window_opener(&new, u);
            NewWindowResponse::Deny
        });
    #[cfg(desktop)]
    let builder = builder.inner_size(1280.0, 820.0).min_inner_size(480.0, 360.0);
    builder.build()
}

/// The world open in the main window, remembered for next time.
#[cfg(desktop)]
fn current_world(app: &AppHandle) -> Option<String> {
    let seen = app.get_webview_window("main").and_then(|w| w.url().ok()).and_then(|u| world_of(&u));
    let state = app.state::<State>();
    match seen {
        Some(w) => {
            if state.get().last_world.as_deref() != Some(&w) {
                state.update(|s| s.last_world = Some(w.clone()));
            }
            Some(w)
        }
        None => state.get().last_world,
    }
}

/// Show (or create) the Assistant window. With `toggle`, a focused window hides instead.
#[cfg(desktop)]
fn show_assistant(app: &AppHandle, world: Option<String>, toggle: bool) -> Result<(), String> {
    let mut url = server_url(app).ok_or("No server address is set yet.")?;
    let world = world.or_else(|| current_world(app));
    let known = world.is_some();
    match &world {
        Some(w) => url.set_path(&format!("/w/{w}/assistant-window")),
        None => url.set_path("/"),
    }
    url.set_query(None);
    let on_top = app.state::<State>().get().assistant_on_top;

    if let Some(win) = app.get_webview_window("assistant") {
        if toggle && win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
            return win.hide().map_err(|e| e.to_string());
        }
        if known && win.url().map(|u| u.path() != url.path()).unwrap_or(true) {
            let _ = win.navigate(url);
        }
        let _ = win.show();
        let _ = win.unminimize();
        return win.set_focus().map_err(|e| e.to_string());
    }

    let (nav, perm) = (app.clone(), app.clone());
    WebviewWindowBuilder::new(app, "assistant", WebviewUrl::External(url))
        .on_permission_request(move |wv, kind| permission_for(&perm, &wv, kind))
        .title("Assistant · Alexandria")
        .inner_size(460.0, 800.0)
        .min_inner_size(340.0, 400.0)
        .always_on_top(on_top)
        .on_navigation(move |u| allow_navigation(&nav, u))
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Windows are created off the event and menu threads, which would otherwise deadlock on Windows.
#[cfg(desktop)]
fn spawn_assistant(app: &AppHandle, world: Option<String>, toggle: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = show_assistant(&app, world, toggle) {
            eprintln!("assistant window: {e}");
        }
    });
}

/// Show (or create) the players' screen window: the TV facing the table. Autoplay with sound is
/// allowed here without a click (the DM chose to open this window): Windows WebView2 through a
/// browser argument, Linux WebKitGTK through the webview setting. macOS WKWebView only takes
/// that choice when the webview is created and Tauri offers no hook for it, so there the
/// screen's own "Click to start" overlay unlocks sound.
#[cfg(desktop)]
fn show_players_screen(app: &AppHandle, world: Option<String>) -> Result<(), String> {
    let mut url = server_url(app).ok_or("No server address is set yet.")?;
    let world = world.or_else(|| current_world(app)).ok_or("Open a world in the main window first.")?;
    url.set_path(&format!("/w/{world}/screen/players"));
    url.set_query(None);

    if let Some(win) = app.get_webview_window("players-screen") {
        if win.url().map(|u| u.path() != url.path()).unwrap_or(true) {
            let _ = win.navigate(url);
        }
        let _ = win.show();
        let _ = win.unminimize();
        return win.set_focus().map_err(|e| e.to_string());
    }

    let (nav, perm) = (app.clone(), app.clone());
    let builder = WebviewWindowBuilder::new(app, "players-screen", WebviewUrl::External(url))
        .on_permission_request(move |wv, kind| permission_for(&perm, &wv, kind))
        .title("Players' screen · Alexandria")
        .inner_size(1280.0, 720.0)
        .min_inner_size(480.0, 270.0)
        .on_navigation(move |u| allow_navigation(&nav, u));
    #[cfg(windows)]
    let builder = builder.additional_browser_args(
        "--autoplay-policy=no-user-gesture-required",
    );
    let win = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    {
        let _ = win.with_webview(|wv| {
            use webkit2gtk::{SettingsExt, WebViewExt};
            if let Some(settings) = wv.inner().settings() {
                settings.set_media_playback_requires_user_gesture(false);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = win;
    Ok(())
}

#[cfg(desktop)]
fn spawn_players_screen(app: &AppHandle, world: Option<String>) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = show_players_screen(&app, world) {
            eprintln!("players' screen window: {e}");
        }
    });
}

#[tauri::command]
fn get_server(app: AppHandle) -> Option<String> {
    app.state::<State>().get().server
}

/// Called by the first-run screen: remember the address and open the web app.
#[tauri::command]
async fn set_server(app: AppHandle, url: String, code: Option<String>) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "That is not a valid address.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("The address must start with http:// or https://".into());
    }
    let origin = parsed.origin().ascii_serialization();
    let changed = app.state::<State>().get().server.as_deref() != Some(&origin);
    app.state::<State>().update(|s| {
        if changed {
            s.last_world = None;
        }
        s.server = Some(origin.clone());
    });
    if changed {
        // The widget's key belongs to the old server.
        forget_widget(&app);
    }
    let mut target = Url::parse(&origin).map_err(|e| e.to_string())?;
    // Connecting from an invite link: go straight to the Join page with its code.
    if let Some(c) = code.filter(|c| invite_code_ok(c)) {
        target.set_path("/join");
        target.set_query(Some(&format!("code={c}")));
    }
    let main = app.get_webview_window("main").ok_or("The main window is gone.")?;
    main.navigate(target).map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn build_menu(app: &AppHandle, on_top: bool) -> tauri::Result<(Menu<Wry>, CheckMenuItem<Wry>)> {
    let show = MenuItem::with_id(app, "show_assistant", format!("Show Assistant ({SHORTCUT})"), true, None::<&str>)?;
    let top = CheckMenuItem::with_id(app, "assistant_on_top", "Assistant always on top", true, on_top, None::<&str>)?;
    let screen = MenuItem::with_id(app, "open_players_screen", "Open players' screen", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "change_server", "Change server…", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let main_menu = Submenu::with_items(app, "Alexandria", true, &[&show, &screen, &top, &sep1, &reload, &change, &sep2, &quit])?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Ok((Menu::with_items(app, &[&main_menu, &edit])?, top))
}

#[cfg(desktop)]
fn on_menu(app: &AppHandle, id: &str) {
    let st = app.clone();
    if tray::on_menu(app, id, move |on| st.state::<State>().update(|s| s.keep_in_tray = Some(on))) {
        return;
    }
    match id {
        "show_assistant" => spawn_assistant(app, None, false),
        "open_players_screen" => spawn_players_screen(app, None),
        "assistant_on_top" => {
            let on = app.state::<OnTopItem>().0.is_checked().unwrap_or(false);
            app.state::<State>().update(|s| s.assistant_on_top = on);
            if let Some(win) = app.get_webview_window("assistant") {
                let _ = win.set_always_on_top(on);
            }
        }
        "reload" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval("location.reload()");
            }
        }
        "change_server" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.navigate(local_url("index.html"));
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            });
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // On Windows and Linux a deep link starts a second copy: hand it to the running one.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        tray::show_main(app);
    }));
    let builder = builder.plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_deep_link::init());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        // Closing the main window hides it to the tray (unless turned off there); Quit is in the tray.
        .on_window_event(|win, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if win.label() == "main" && win.app_handle().state::<State>().get().keep_in_tray.unwrap_or(true) {
                    api.prevent_close();
                    let _ = win.hide();
                }
            }
        });
    builder
        .invoke_handler(tauri::generate_handler![get_server, set_server])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = State::load(app.path().app_config_dir()?.join("settings.json"));
            #[cfg(desktop)]
            let on_top = state.get().assistant_on_top;
            app.manage(state);

            #[cfg(desktop)]
            {
                let (menu, top) = build_menu(&handle, on_top)?;
                app.manage(OnTopItem(top));
                handle.set_menu(menu)?;
            }

            let main = create_main(&handle)?;
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installed from a .tar.gz or an AppImage, the scheme is registered here.
                #[cfg(any(target_os = "linux", windows))]
                let _ = handle.deep_link().register_all();
                let h = handle.clone();
                handle.deep_link().on_open_url(move |e| {
                    for u in e.urls() {
                        open_link(&h, &u);
                    }
                });
                // Opened by a link while it was not running.
                if let Ok(Some(urls)) = handle.deep_link().get_current() {
                    for u in urls {
                        open_link(&handle, &u);
                    }
                }
            }
            #[cfg(desktop)]
            {
                tray::build(&handle, handle.state::<State>().get().keep_in_tray.unwrap_or(true))?;
                if tray::started_minimized() {
                    let _ = main.hide();
                }
            }
            #[cfg(not(desktop))]
            let _ = main;

            #[cfg(desktop)]
            {
                let for_shortcut = handle.clone();
                if let Err(e) = app.global_shortcut().on_shortcut(SHORTCUT, move |_app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        spawn_assistant(&for_shortcut, None, true);
                    }
                }) {
                    // Another program may already own the shortcut; the menu still works.
                    eprintln!("could not register {SHORTCUT}: {e}");
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Alexandria")
        .run(|_app, _event| {
            // macOS: clicking the Dock icon brings back a window hidden to the menu bar.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show_main(_app);
            }
        });
}
