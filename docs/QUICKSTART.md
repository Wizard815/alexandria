# Quickstart: from a fresh Linux server to a table

Short and exact. Ubuntu 22.04 or 24.04 is assumed. Replace `dnd.example.com`
with your own domain everywhere. For more detail see [HOSTING.md](HOSTING.md).

## 1. Install Docker and get the code

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"        # log out and in again once
git clone https://github.com/Wizard815/alexandria && cd alexandria
```

## 2. Configure `librarian/.env`

```bash
cp librarian/.env.example librarian/.env
nano librarian/.env
```

Docker Compose reads this file (`env_file`). The settings that matter:

| Variable | Set it to | Why |
|---|---|---|
| `ALX_PUBLIC_URL` | `https://dnd.example.com` | The address people use. Goes into invite links and AI-connection settings. |
| `ALX_TRUST_PROXY` | `1` | Required behind nginx, so client IPs and `https` are read from its headers. (The nginx override sets it too.) |
| `ALX_ADMIN_TABLE_LOGIN` | `1` (optional) | Lets one person be both DM and admin on a small server: the table sign-in then also opens the admin pages. Otherwise admins use `/admin/login`. |
| `ALX_ADMIN_ALLOW` | e.g. `192.168.0.0/16,127.0.0.1/32` (optional) | Only these networks may use the admin pages. |
| `MODEL_BASE_URL`, `MODEL_API_KEY` | an OpenAI-compatible endpoint | The AI features. Or `LOCAL_LLM_URL=http://host.docker.internal:11434` for Ollama / LM Studio on this machine. |
| `ALX_MODEL_<JOB>_URL`, `_MODEL`, `_KEY` | per job (`CHAT`, `AUDIT`, `AUDIO`, `VOICE`, `EXTRA`) | A different model per job. Easier: do it in the Models page (step 9), which wins over these. |
| `ALX_LIBFILE_VIDEO_MAX_MB` | default 2048 | Largest video upload. nginx is set to 2 GB as well. |

Nothing is needed to start: with an empty `.env` the app runs and you add
models later. Never commit `librarian/.env`.

## 3. Build and run

```bash
scripts/build.sh up-nginx     # builds the image, runs it on 127.0.0.1:8090 only
curl http://127.0.0.1:8090/health      # {"status":"ok", ... "release":"AlphaV1"}
```

Other commands: `scripts/build.sh image | up | down | logs | desktop | android | test`.
`up` publishes the port on all interfaces (fine for a LAN, see step 10).
Docker Hub rate limit? `NODE_IMAGE=mirror.gcr.io/library/node:24-alpine scripts/build.sh up-nginx`.

Everything (database, uploads, recordings) is in `./data`. It survives
`down`, `up` and rebuilds. Back it up (see HOSTING.md). Session audio ends up
as plain files in `./data/recordings/<World>/<date> <Session>/` (a full mix,
one file per microphone, the transcript and a `session.json`); they are the
only copy of the audio, so back that folder up too.

## 4. nginx and a certificate

Point the DNS name at the server and open ports 80 and 443.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx/alexandria.conf /etc/nginx/sites-available/alexandria.conf
sudo sed -i 's/dnd.example.com/YOUR.DOMAIN/g' /etc/nginx/sites-available/alexandria.conf
sudo certbot certonly --nginx -d YOUR.DOMAIN         # needs port 80 free for a moment
sudo ln -s /etc/nginx/sites-available/alexandria.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The site file redirects http to https, proxies to `127.0.0.1:8090`, turns
off buffering for the live-update stream (`/api/worlds/<world>/events`, the
only long-lived connection; there are no WebSockets), allows 2 GB uploads
and sets the `X-Forwarded-*` headers. For a LAN with no certificate use
`deploy/nginx/alexandria.http.conf` instead (phones can then only add a
shortcut, not install the app). Renewal is automatic (`certbot renew` runs
from a timer).

## 5. First run

Open `https://YOUR.DOMAIN`. It asks for the admin account (the first account
is always the admin). Then:

1. **Library admin → Accounts → Add account** for the DM. You get a one-time
   reset code; the DM opens `/reset`, enters it with the username and
   chooses a password. (If one person is both DM and admin, skip this: use
   your admin account as the DM in the next step and set
   `ALX_ADMIN_TABLE_LOGIN=1` in `librarian/.env`.)
2. **Library admin → Worlds → New empty world:** a name and the DM.
3. Admin sign-in is separate from the table sign-in once there is a second
   account: admins sign in at `https://YOUR.DOMAIN/admin/login`.

## 6. Add the DM and the players

As the DM: **World settings → Invite players → Make an invite code**. Send
the link (`https://YOUR.DOMAIN/join?code=…`) or the code. The player opens
it on a phone or computer, picks a username and password, and is in. A code
works once and expires. The DM then opens **The table** (the DM screen).

## 7. Connect LegendKeeper

Library admin → **Connections → New connection → LegendKeeper (API key)**:

- *Project API URL*: `https://www.legendkeeper.com/api/v3/projects/<your project id>`
- *API key*: LegendKeeper → Project Settings → Developers → API Keys. Use an
  **Admin** key (so hidden pages arrive marked hidden). API keys need the
  project owner on a paid plan.

Press **Test**: a wrong or missing key gives a plain message. Then
**World sources → add a source** for the world and press **Sync**. Pages
stay DM-only until they are known to be safe for players.

## 8. Link Argos (your models)

[Argos](https://github.com/Wizard815/Argos) listens on port 8080 by
default. The Alexandria container must be able to reach it. If Argos runs on
the same machine as Docker, add the host alias with a compose override (it
also sets the model variables; skip those lines if you use the Models page):

```bash
docker compose -f docker-compose.yml -f deploy/examples/nginx.override.yml \
  -f deploy/examples/argos.override.yml up -d
```

The address to paste is then `http://host.docker.internal:8080`. On another
machine use its address, e.g. `http://192.168.1.50:8080`. Then in Library
admin → **Models**: paste the Argos address in the **Argos** card, press
**Discover**, check the suggested model per job (chat, audit, speech to
text, voice, embeddings) and press **Save provider**, then **Save** on each
job you changed.

**Keep Argos (and Ollama, whisper, Kokoro) private.** Bind them to `127.0.0.1` or the Docker network, and never forward their ports on your
router. A model server that can be reached from the internet can be used by anyone, and it bypasses Alexandria's sign-in and the guard that
keeps classified text from models. Set Argos `apiKeys` and `ARGOS_API_KEY` (in `librarian/.env`) so the Models page and the container
authenticate to it. The `/v1` gateway Alexandria itself offers is for the DM and the admin only (see `docs/SECURITY.md`).

**RAM:** give the container 2 GB (4 GB for a big library with embeddings). See `docs/HOSTING.md`.

## 9. Choose the microphone and the speakers

- **DM, Audio setup** (`/w/<world>/dm/audio`): the list of microphones
  this computer has. Switch on the one(s) to record, then **Start recording**.
  The browser asks for microphone permission once. This needs **https** (or
  localhost).
- **DM, Sound board → Speakers:** pick the output device for music, ambience,
  effects and the read-aloud voice (Chrome and Edge can choose outputs;
  Firefox and Safari play on the default output).
- **Assistant, microphone button (slider icon next to it):** the microphone
  used for dictation. Remembered per browser.
- **Players, Audio:** each player picks their own microphone and agrees to
  recording on their own device.
- **DM, Recordings** (`/w/<world>/dm/recordings`): after a session stops the
  audio is joined in the background (ffmpeg is in the Docker image). Play the
  full recording or any microphone, click a transcript line to jump there,
  download files, and choose per session how long the audio is kept (blank
  keeps forever; the transcript always stays). Players find their own
  microphone's track under **My recordings**.

## 10. Install the apps

Releases are on the GitHub Releases page of the repository ("Alexandria
AlphaV1"). Each app asks for your server address on first run and then signs
in like the website.

| Device | Install | Get it | First run |
|---|---|---|---|
| Ubuntu / Linux (DM) | the tar.gz | `Alexandria-AlphaV1-linux-x86_64.tar.gz` | `tar xzf` it, `cd` in, `./install.sh`, start **Alexandria** from the menu. Needs `sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0`. Enter `https://YOUR.DOMAIN`. |
| Windows | the setup program | `Alexandria-AlphaV1-windows-x64-setup.exe` | Run it. Windows SmartScreen may warn about an unknown publisher (the app is not code-signed): **More info → Run anyway**. Enter the server address. |
| macOS | the disk image | `Alexandria-AlphaV1-macos-universal.dmg` | Open it, drag Alexandria to Applications. It is not notarised, so the first start is blocked: **right-click the app → Open → Open**, or **System Settings → Privacy & Security → Open Anyway**. Enter the server address. |
| Android phone | the APK | `Alexandria-AlphaV1-android.apk` | Download it on the phone and open it; allow "install unknown apps" for your browser/file manager when asked. Enter the server address. Allow the microphone when asked. Updates must be signed with the same key (a release with a different key means uninstalling first). |
| iPhone / iPad | the website, no app | open `https://YOUR.DOMAIN` in **Safari** | **Share → Add to Home Screen**. See below. |
| Any phone or computer | the website (PWA) | `https://YOUR.DOMAIN` | Android Chrome: **menu → Install app**. Desktop Chrome/Edge: install icon in the address bar. |

### Phones: the installable web app

Open `https://YOUR.DOMAIN` on the phone → **Add to Home Screen** (Android
Chrome: menu → *Install app*; iPhone Safari: Share → *Add to Home Screen*). It
opens full screen, stays signed in and keeps working for the pages it has
saved when the signal drops. This needs **https with a real certificate** (the
certbot one is). On plain LAN http a phone can only make a shortcut.

### iPhone: why the website

- Needs **iOS 16.4 or newer** for the home-screen app to receive notifications.
- Allow the **microphone** when Safari asks. Keep the app open in the
  foreground while recording: iOS pauses a page that is in the background.
- There is no iPhone app on purpose: installing one outside the App Store
  needs a Mac with Xcode and an Apple ID and has to be re-signed every 7 days
  (or a paid Apple developer account). The website is the recommended path
  and has the same features.

## Updating

```bash
git pull && scripts/build.sh up-nginx      # rebuilds and restarts; ./data is kept
```

## Building the apps yourself

```bash
scripts/build.sh desktop     # this computer's desktop app (Rust, Node and the Tauri libraries)
scripts/build.sh android     # the APK (Android SDK, NDK, Java 17)
```

Releases are built by `.github/workflows/release.yml` when a `v*` tag is
pushed. The release name is the file `RELEASE_NAME`, the version is `VERSION`.
