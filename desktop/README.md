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

Not part of the root npm workspaces, and not built by the server's Docker
image. Status: the Rust code was written against the Tauri 2.12 docs but has
not been compiled or run yet (the authoring machine had no GTK/WebKit
libraries), so expect to fix small compile errors on the first `npm run dev`.

## Layout

| Path | What |
|---|---|
| `ui/` | The first-run screen (plain HTML and JS, no build step) |
| `src-tauri/src/lib.rs` | Windows, menu, shortcut, saved address |
| `src-tauri/tauri.conf.json` | App and bundle config; no windows are declared, Rust creates them |
| `src-tauri/capabilities/` | Permissions for the bundled screen |
