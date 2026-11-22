**Alexandria AlphaV1** (version 0.1.0-alpha.1): the first build to try at a real table. It is an alpha: it works end to end, and it has rough edges.

## What is in it

- **The server** as one Docker image: the library, the DM screen, the players' app, live sync, recording and transcripts, the sound board, the stage and players' screen, and the MCP gateway for AI apps.
- **Admin and setup in the browser:** first-run admin account, worlds, accounts, invite codes for players, LegendKeeper and other connections, and the Models page (link Argos and pick a model per job).
- **Apps:** Windows, macOS, Linux desktop apps and an Android app. Each is the website in a native window that asks for your server address on first start. iPhone and iPad use the website (Add to Home Screen).
- **Reverse proxy:** ready-made nginx files for a domain with HTTPS and for plain HTTP on a LAN.

## Known not to work yet, or rough

- The apps are **not code-signed**: Windows shows a SmartScreen warning, macOS needs right-click, Open, and Android needs "install unknown apps". Steps are in the quickstart.
- Android: the APK is signed with a throwaway key unless the project's key was supplied, so an update only installs over it if it was signed with the same key (otherwise uninstall first). Changing the server address means clearing the app's data in Android settings.
- iPhone: no app (installing one needs a Mac, Xcode and re-signing every 7 days). Use the website; the microphone needs the app in the foreground.
- Plain `http://` on a LAN name has no service worker, no installable web app and no microphone in browsers (they require HTTPS or `localhost`). Use the HTTPS setup for phones and microphones.
- Player microphones saved by one browser may need picking again if the browser changes its device ids.
- A LegendKeeper connection needs the project owner on a paid plan and an Admin API key. It was not tried with a real account in this build's checks, only up to LegendKeeper's own "401" answer.
- Tested with a stand-in model server and Argos' own test responder, not a full GPU setup.

## Install

Everything is in [docs/QUICKSTART.md](https://github.com/Wizard815/alexandria/blob/main/docs/QUICKSTART.md): server, nginx and a certificate, first run, players, LegendKeeper, Argos, microphones, and each device.

| Device | File |
|---|---|
| Linux (Ubuntu) | `Alexandria-AlphaV1-linux-x86_64.tar.gz` (unpack, run `./install.sh`) |
| Windows | `Alexandria-AlphaV1-windows-x64-setup.exe` |
| macOS | `Alexandria-AlphaV1-macos-universal.dmg` (first start: right-click, Open) |
| Android | `Alexandria-AlphaV1-android.apk` |
| iPhone / iPad | open your server's address in Safari, then Share, Add to Home Screen |
| Server | `docker pull ghcr.io/<owner>/alexandria:alphav1` or `scripts/build.sh up` from a clone |
