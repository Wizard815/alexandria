# Alexandria desktop app

A small [Tauri 2](https://tauri.app) wrapper around the Alexandria web app.
It has no copy of the app inside: on first run it asks for your server's
address (remembered), then loads that server in a native window. You sign in
with the same account as in a browser; nothing here bypasses the server's auth.

What it adds over the browser:

- **Assistant window.** A separate window that shows the DM assistant
  (`/w/<world>/assistant-window`) for the world open in the main window. The
  assistant's pop-out button opens it too.
- **Always on top.** Menu: Alexandria, "Assistant always on top". Remembered.
- **Global shortcut.** Ctrl+Shift+Space (Cmd+Shift+Space on macOS) shows and
  focuses the Assistant window from any program, and hides it again if it is
  already in front. If another program owns that shortcut, the menu item
  "Show Assistant" still works.
- **Push-to-talk** is the assistant's own mic button, the same as in the browser.
- **Change server** from the Alexandria menu; **Reload** too.

The web app and the Assistant window are remote pages and are given no access
to the app (`src-tauri/capabilities/default.json` covers only the bundled
first-run screen, with `core:default`). Window, menu and shortcut handling are
done in Rust, so no always-on-top or shortcut permission is exposed to the
page. Links to other sites open in the system browser.

The saved address lives in `settings.json` in the app's config folder
(for example `~/.config/app.alexandria.desktop/` on Linux).

## Build

Needs Node 22+, Rust (stable, 1.77+) and the Tauri system libraries for your
OS: <https://tauri.app/start/prerequisites/>. On Debian/Ubuntu that is
`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev`
plus a C toolchain.

```bash
cd desktop
npm install
npm run dev        # runs the app with a debug build
npm run build      # installers in src-tauri/target/release/bundle/
```

Icons in `src-tauri/icons/` are generated from `app-icon.png`
(`npm run icons`); that image comes from `web/scripts/make-icons.mjs`.

Linux packaging: `npx tauri build --no-bundle` then `../scripts/package-linux.sh`
makes `Alexandria-<release>-linux-x86_64.tar.gz` (binary, icon, .desktop file and an
`install.sh` that copies them under `~/.local`). Windows: `npx tauri build --bundles nsis`
(the setup .exe). macOS: `npx tauri build --target universal-apple-darwin --bundles dmg`.

## Android

The same app as an APK (Tauri 2 mobile, project in `src-tauri/gen/android`, committed).
Needs the Android SDK (platform 36, build-tools 36, NDK 26.1), Java 17 or newer and the
Rust Android targets (`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`).

```bash
export ANDROID_HOME=~/Android/Sdk NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125
cd desktop && npx tauri android build --apk              # all phone ABIs
npx tauri android build --apk --target aarch64           # arm64 only, faster
# APK: src-tauri/gen/android/app/build/outputs/apk/universal/release/
```

- First run asks for the server address, exactly like the desktop app. The web app is a
  remote page with no access to the app; links to other sites open in the browser.
- **Microphone:** `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` are in the manifest, and
  `permission_for` in `src/lib.rs` answers the web view's microphone request with "allow" only
  for a page of the saved server address (camera, location and screen capture are refused).
  Android shows its own permission prompt once.
- The screen stays awake while the app is open; the back button goes back in the web app and
  leaves the app at the first page. Plain `http://` servers are allowed (home network);
  https is recommended.
- **Status bar:** the app draws edge to edge (`MainActivity.kt`), pads the status bar, navigation
  bar and keyboard once in the native view over the web app's bar colour (`#171C26`) and hands
  the page no inset of its own, so the page's top bar sits snugly under the status bar. Change
  that colour in `MainActivity.kt` together with `--side` in `web/src/theme.css`. A change here
  needs a rebuilt APK; the web part updates with the server.
- **Signing:** `gen/android/keystore.properties` (never committed) names the key; without it
  the release APK is signed with the debug key so it still installs. An update installs over
  an earlier build only if it was signed with the same key. The release workflow reads the
  key from the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` and
  `ANDROID_STORE_PASSWORD` secrets.
- To change the server address on Android, clear the app's data in system settings.

Not part of the root npm workspaces, and not built by the server's Docker image. The
Linux build and the Android arm64 build were compiled and checked for AlphaV1; the
Windows and macOS builds are made by the release workflow.

## Layout

| Path | What |
|---|---|
| `ui/` | The first-run screen (plain HTML and JS, no build step) |
| `src-tauri/src/lib.rs` | Windows, menu, shortcut, saved address |
| `src-tauri/tauri.conf.json` | App and bundle config; no windows are declared, Rust creates them |
| `src-tauri/capabilities/` | Permissions for the bundled screen |
