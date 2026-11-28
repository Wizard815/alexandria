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

**App links.** A page of the saved server asks the app for something by going to
`/app-link/<action>`: the app cancels that navigation and acts (`app_link` in `src/lib.rs`):
`widget#k=...&w=...` (Android: link the home-screen widget), `widget-off`, `change-server`.
In a browser the same address shows "Open this in the app". Nothing else is reachable that way.

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
- **Change server:** More, This device, Change server (or clear the app's data in system settings).
- **Home-screen widgets** (`gen/android/.../widget/`): *Alexandria: character* (2x1: your HP, temp
  HP, mana and conditions; for the DM, whose turn it is) and *Alexandria: table* (4x2: world date,
  the fight or session or next game night, quick events, the bars, and what waits for you). Link
  them in the app: More, This device, Home-screen widget. That makes a widget key on the server
  (`alx_wdg_`, read-only, opens only `GET /api/worlds/<world>/glance`) and hands it to the app
  through `/app-link/widget#k=...&w=...`; `app_link` in `src/lib.rs` writes `widget.json`
  (server, world, key) next to `settings.json`, where only this app can read it. Changing server
  forgets it. The widgets load every 30 minutes (Android's shortest period), when you leave the
  app, and from their ↻ button; offline they show the last answer and when it was from. A tap
  opens the app at the right page (Live in a fight, the quick event, the calendar).
- **Updates from your own server** (`src/update.rs`, `gen/android/.../AppUpdater.kt`): the server
  keeps the app builds in `ALX_APPS_DIR` (see docs/HOSTING.md). The page knows the app's
  version from `window.__ALEXANDRIA_APP__` (set by an initialization script). When the server has
  a newer build for this platform, a banner offers it, and More, This device, Updates has an
  "Update to ..." button and an automatic-update switch. The page asks the server for a
  15-minute ticket and opens `/app-link/update#f=<file>&t=<ticket>&s=<sha256>`. The app downloads
  from its saved server only and checks the SHA-256, then:
  Android opens the system installer (it asks once to allow installs from Alexandria, and the APK
  must be signed with the same key); Windows runs the setup in passive mode and closes; Linux
  unpacks the .tar.gz, runs its `install.sh` and restarts (an AppImage replaces itself); macOS
  opens the .dmg to drag into Applications. Before installing, the Android app compares the
  update's signing key with its own and, if they differ, tells the person to uninstall and
  reinstall instead of letting Android fail with "App not installed".
- **Notifications** (`Notifications.kt`, `notify_os` in `src/lib.rs`): the alerts of the glance (your
  turn, a quick event for you, game night within the hour, an answer to your request; for the DM,
  a new request), filtered by what the person picked on This device. While the app runs, the page
  sends each new one through `/app-link/notify#i=&t=&b=&p=`: Android posts it (a tap opens the
  page), the desktop apps use the notification plugin. With the widget link in place, Android also
  checks every 15 minutes when the app is closed (WorkManager), for the linked world. Android 13+
  asks once for permission. Browsers and the iPhone home-screen app get web push from the server
  instead (`librarian/src/features/notify`).
- **Answer from the notification** (Android): a quick event's notification has "Roll for me" or its
  first three choices. A tap answers with the widget's key (`POST /glance/answer`, its one allowed
  write), so it needs the widget link for that world; without it, a tap opens the app.
- **Tray** (desktop, `src/tray.rs`): closing the window keeps Alexandria in the tray (menu bar on
  macOS), so notifications keep coming. The tray menu: Open, Show Assistant, Keep running when the
  window is closed, Start with the computer (autostart plugin, starts in the tray), Quit.
- **Invites open in the app:** `alexandria://join?server=<origin>&code=<code>` (deep-link plugin; one
  running copy on Windows and Linux via single-instance). The Join page offers "Open in the
  Alexandria app" for an invite link, and the DM's invite shows a QR code of the link. An invite for
  another server goes to the first-run screen first, with the address filled in.
- **Recording with the screen locked** (Android, `Recording.kt`): while this phone records as a table
  mic, the page sends `/app-link/recording#on=1`; a microphone foreground service (with its
  "Recording the session" notification) and a CPU wake lock keep it going, and the web view is kept
  running when the screen goes off.
- **Share to Alexandria** (Android): text, links and pictures from any app's Share menu open
  `/share`, where the person picks the world and where it goes: the table or party chat, or for the
  DM the library's files or the stage. Pictures up to 12 MB in all.
- **Getting builds onto the server:** Admin, App builds. "Fetch the latest release" copies every
  platform's build from GitHub (the release workflow builds macOS on GitHub's own Macs, so no Mac
  is needed); "Upload a build" takes a file from any computer, for example a macOS build someone
  made on their Mac. The release workflow sets the app's version from
  `VERSION`, so the apps and the server's builds compare correctly.

Not part of the root npm workspaces, and not built by the server's Docker image. The
Linux build and the Android arm64 build were compiled and checked for AlphaV1; the
Windows and macOS builds are made by the release workflow.

## Layout

| Path | What |
|---|---|
| `ui/` | The first-run screen (plain HTML and JS, no build step) |
| `src-tauri/src/lib.rs` | Windows, menu, shortcut, saved address, app links (`/app-link/...`) |
| `src-tauri/gen/android/.../widget/` | The Android home-screen widgets (Kotlin; layouts in `res/layout/widget_*.xml`) |
| `src-tauri/tauri.conf.json` | App and bundle config; no windows are declared, Rust creates them |
| `src-tauri/capabilities/` | Permissions for the bundled screen |
