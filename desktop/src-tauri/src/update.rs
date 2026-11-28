//! Updates from the person's own Alexandria server (librarian/src/features/appbuilds).
//!
//! The web app asks for a 15-minute download link (a ticket) while signed in and hands it to the
//! app through `/app-link/update#f=<file>&t=<ticket>&s=<sha256>`. Only the saved server is ever
//! contacted, and a file whose SHA-256 differs from what the server listed is thrown away.
//!
//! - Android: the link is written to `update.json` next to `settings.json`; the Kotlin side
//!   (`AppUpdater.kt`) downloads the APK and opens Android's installer, which asks the person.
//! - Windows: the setup .exe runs in passive mode (a progress bar, no questions), and the app
//!   quits so the installer can replace it; start Alexandria again afterwards.
//! - Linux: the .tar.gz is unpacked and its `install.sh` run (to ~/.local), then the new copy
//!   starts. An .AppImage replaces the running one. A .deb opens in the system's installer.
//! - macOS: the .dmg opens; drag Alexandria into Applications.
//!
//! Progress goes to the page as a `alexandria-update` DOM event: {state, message}.

use tauri::{AppHandle, Manager, Url};

/// Tell the page how the update is going (the This device page and the update banner listen).
pub fn notify(app: &AppHandle, state: &str, message: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let detail = serde_json::json!({ "state": state, "message": message });
        let _ = win.eval(&format!("window.dispatchEvent(new CustomEvent('alexandria-update', {{ detail: {detail} }}))"));
    }
}

#[cfg(target_os = "android")]
pub fn start(app: &AppHandle, src: Url, file: String, sha: String) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let body = serde_json::json!({ "url": src.as_str(), "file": file, "sha256": sha });
    // Written whole, then renamed, so the Kotlin side never reads half a file.
    let tmp = dir.join("update.json.tmp");
    if std::fs::write(&tmp, body.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join("update.json"));
        notify(app, "downloading", "Downloading the update…");
    }
}

#[cfg(not(target_os = "android"))]
pub fn start(app: &AppHandle, src: Url, file: String, sha: String) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        notify(app, "busy", "An update is already downloading.");
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        notify(&app, "downloading", "Downloading the update…");
        let result = download(&src, &file, &sha).and_then(|path| install(&app, &path));
        if let Err(e) = result {
            notify(&app, "failed", &format!("The update did not install: {e}"));
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

#[cfg(not(target_os = "android"))]
fn download(src: &Url, file: &str, sha: &str) -> Result<std::path::PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let dir = std::env::temp_dir().join("alexandria-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(file);
    let resp = ureq::get(src.as_str()).call().map_err(|e| format!("the server said {e}"))?;
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    drop(out);
    let got = format!("{:x}", hash.finalize());
    if got != sha {
        let _ = std::fs::remove_file(&path);
        return Err("the download does not match the server's checksum".into());
    }
    Ok(path)
}

#[cfg(not(target_os = "android"))]
fn install(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_ascii_lowercase();
    if cfg!(windows) {
        if !(name.ends_with(".exe") || name.ends_with(".msi")) {
            return Err("this is not a Windows installer".into());
        }
        notify(app, "installing", "Installing. Alexandria closes now; open it again when the installer finishes.");
        if name.ends_with(".msi") {
            Command::new("msiexec").arg("/i").arg(path).arg("/passive").spawn().map_err(|e| e.to_string())?;
        } else {
            Command::new(path).arg("/P").spawn().map_err(|e| e.to_string())?;
        }
        std::thread::sleep(std::time::Duration::from_millis(800));
        app.exit(0);
        return Ok(());
    }
    if cfg!(target_os = "macos") {
        if !name.ends_with(".dmg") {
            return Err("this is not a macOS disk image".into());
        }
        Command::new("open").arg(path).spawn().map_err(|e| e.to_string())?;
        notify(app, "ready", "The new version opened in Finder: drag Alexandria into Applications, replace the old one, then reopen it.");
        return Ok(());
    }
    // Linux
    if name.ends_with(".tar.gz") {
        let dir = path.with_extension("").with_extension("");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let ok = Command::new("tar").arg("-xzf").arg(path).arg("-C").arg(&dir).status().map_err(|e| e.to_string())?;
        if !ok.success() {
            return Err("could not unpack the download".into());
        }
        let script = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("install.sh"))
            .find(|p| p.exists())
            .ok_or("the download has no install.sh")?;
        notify(app, "installing", "Installing…");
        let ok = Command::new("sh").arg(&script).status().map_err(|e| e.to_string())?;
        if !ok.success() {
            return Err("install.sh failed".into());
        }
        let home = std::env::var("HOME").map_err(|_| "no HOME")?;
        let bin = std::path::Path::new(&home).join(".local/bin/alexandria");
        notify(app, "restarting", "Installed. Restarting Alexandria…");
        Command::new(&bin).spawn().map_err(|e| e.to_string())?;
        app.exit(0);
        return Ok(());
    }
    if name.ends_with(".appimage") {
        let current = std::env::var("APPIMAGE").map_err(|_| "this copy was not started from an AppImage")?;
        std::fs::copy(path, &current).map_err(|e| e.to_string())?;
        notify(app, "restarting", "Installed. Restarting Alexandria…");
        Command::new(&current).spawn().map_err(|e| e.to_string())?;
        app.exit(0);
        return Ok(());
    }
    if name.ends_with(".deb") {
        Command::new("xdg-open").arg(path).spawn().map_err(|e| e.to_string())?;
        notify(app, "ready", "The package opened in your system's installer.");
        return Ok(());
    }
    Err("this is not a Linux build".into())
}
