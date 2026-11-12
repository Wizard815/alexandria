# Alexandria build schedule

The order to build [PLAN.md](PLAN.md) in, as milestones with checklists. Tick
items off as they land on `main`.

## How the order was chosen

1. **The base comes first.** That means CI, the model connections and the
   test shapes for phones. Everything later is checked against them.
2. **What you see every session comes before what you add later.** Phone
   screens, the world date and the broker come before audio.
3. **Each milestone depends only on milestones above it.** The audio work
   needs the desktop app, the session log needs audio and the agent, and
   date changes from summaries need the world clock.
4. **The leak check never waits.** Every milestone that shows anything new to
   players includes its leak test.

## Schedule at a glance

Week 1 starts Monday 16 November 2026. The weeks assume steady work with
two build tracks running side by side:
- **Track A:** screens and apps
- **Track B:** gateway and AI

The weeks are estimates and will move. The order matters more than the dates.

| Weeks | Dates | Track A: screens and apps | Track B: gateway and AI | Milestone done |
|---|---|---|---|---|
| 1 | 16–22 Nov | Phone test shapes (needs your Fold sizes) | CI; Admin → Models with the five model jobs | **M0** |
| 2–3 | 23 Nov–6 Dec | Phone redesign: player screens | Gateway admin sign-in | |
| 4 | 7–13 Dec | Phone redesign: DM assistant | World clock and calendar | **M1** |
| 5 | 14–20 Dec | World date on screens, home events | Broker: auto-delivery, scope, "Other", site link | **M2** |
| 6–7 | 21 Dec–3 Jan | *(holidays: light week)* Item cards | Game modules: SRD 5.2 and 5.1, import | |
| 8 | 4–10 Jan | Item cards on every screen | Intake capabilities, Kanka relations and calendars, push API | **M3** |
| 9–10 | 11–24 Jan | Agent chat panel, statblock to combat | Two harnesses, agent tools, audit model and the 40-question test | **M4** |
| 11–12 | 25 Jan–7 Feb | Desktop app shell (Tauri), audio setup screen | Audio upload, consent, storage, backups | |
| 13–14 | 8–21 Feb | Mic modes and hold keys, speaker groups | Speech to text, mic merge, asides across mics | **M5** |
| 15 | 22–28 Feb | Transcript island, keyword cards | Transcript views (DM and players) | **M6** |
| 16–17 | 1–14 Mar | Session log page and review | Summary drafts, proposed date changes, travel | **M7** |
| 18–20 | 15 Mar–4 Apr | Soundboard, mood map, ambience mixer, player switches | Music and ambience streaming, Spotify | **M8** |
| 21 | 5–11 Apr | Speak menu, voice presets | Kokoro connection | **M9** |
| 22–23 | 12–25 Apr | Android APK, iOS build, Get the app page | Release builds in CI | **M10** |
| 24 | 26 Apr–2 May | Fixes from real sessions | Leak test sweep, load test, docs | **M11** |

**About 24 weeks, with the full plan done early May 2027.** Each milestone
is usable on its own, so the table gets new features every few weeks rather
than all at the end.

---

## What you need to give me

| When | What | Why |
|---|---|---|
| Week 1 | Your Z Fold's viewport sizes, folded and unfolded. Open `whatismyviewport.com` in the phone's browser. | Test shapes for the phone redesign |
| Week 1 | The GPU machine running Argos, plus the model files you want for chat and audit | M0 model connections |
| Week 2 | 10 minutes on the phone redesign drafts | Pick a direction before it's built |
| Week 11 | Your mics and speakers: names and how they connect (USB, Bluetooth, audio interface) | Audio setup |
| Week 11 | The consent text you want players to agree to | Recording consent |
| Week 18 | Music and ambience files, sorted into folders | The music board and ambience |
| Week 18 | A Spotify developer app (client ID), made at developer.spotify.com | Spotify sign-in |
| Week 22 | An Apple ID for sideloading (free or paid) | The iOS build |
| Any time | A recorded test session, 20–30 minutes with everyone's consent | Tuning the mic merge and summaries |

---

## M0: Base (week 1)
- [ ] **CI** (GitHub Actions): librarian tests, typechecks, web build and both
  browser tests on every push to `main`
- [ ] **Phone test shapes:** narrow (Fold cover), normal phone, near-square
  (Fold inner), desktop. A Playwright helper that fails on sideways scroll
  or cut-off text.
- [ ] **Admin → Models:** five jobs (chat, audit, audio, voice, extra), each
  an endpoint and a model name, with a Test button
- [ ] **`deploy/examples`:** Argos, whisper server, Kokoro, each as an
  override file
- [ ] **Leak test helper:** one shared function every new test calls to
  scan a player response for DM-only text

**Done when:** CI is green, Admin → Models reaches your Argos, and the
four test shapes run.

## M1: Phone redesign and sign-in (weeks 2–4) · PLAN §15, §13
- [ ] **Design drafts:** three player screens and the DM assistant at
  phone and Fold-inner sizes. You pick one direction.
- [ ] **New phone shell:** bottom tabs (Home, Live, Library, Broker, Bag),
  bottom sheets, a "More" sheet
- [ ] **Two-pane layout** for near-square screens; it keeps your place when
  the Fold opens or closes
- [ ] **Player screens redone phone-first:** Home, Live, Library, Broker,
  Bag, Me, Messages, Calendar
- [ ] **The DM assistant:** initiative and turn, HP and conditions, quick
  actions, approvals and broker queues, a placeholder for the agent chat
- [ ] **`/admin/login`:** separate admin sessions, an optional authenticator
  app, an optional allowed-network list
- [ ] **Tests:** every screen at all four shapes; admin and table sessions
  can't cross

**Done when:** every player screen and the DM assistant pass all four
shapes, and you've checked it on your Fold.

## M2: World clock and broker (weeks 4–5) · PLAN §14, §1.1–1.4
- [ ] **World clock:** the date and time in the world's calendar, with
  the calendar from the source or set by the DM
- [ ] **The broker clock** moves onto it, keeping existing waits
- [ ] **The world date** shows in the top bar for the DM and players
- [ ] **Home pages:** today's events plus upcoming ones, with a per-person
  range of 3, 7 or 30 days
- [ ] **DM buttons:** Long rest, Short rest, Next day, Set date. Changes
  are logged and can be undone.
- [ ] **Broker delivery mode per tier** (Auto or DM reviews); Guarded is
  always the DM
- [ ] **Broker scope:** world only, plus real-world topics the DM allows;
  others are refused in character
- [ ] **"Other":** free rules and item questions, not shown as a price tier
- [ ] **World site link** setting, shown on the broker page
- [ ] **Tests:** auto never delivers a guarded question; scope refusals;
  shared events only

## M3: Item cards, game modules, intake (weeks 6–8) · PLAN §2, §4.3, §9
- [ ] **Item to library page link,** with a page search in the item form
- [ ] **The item card:** 3-second hover (adjustable), the pointer can move
  into it, it scrolls, ⓘ on touch, Enter from the keyboard
- [ ] **Game modules:**
  - SRD 5.2 (default) and SRD 5.1 built in
  - import from zip, folder, JSON, git or API, with a preview
  - several modules on at once, with an order
  - `docs/MODULES.md`
- [ ] **Connector capabilities:** each connector declares what it provides,
  and screens use what's there
- [ ] **Kanka:** relations, calendars (these feed the world clock), timelines,
  map markers
- [ ] **LegendKeeper:** calendars, timelines, maps as pages
- [ ] **Push intake:** `POST /api/intake/<source>/entries` with a source key
- [ ] **Tests:** an item linked to a DM-only page shows players nothing from
  it; leak tests for every new Kanka or LegendKeeper kind

## M4: DM agent and question routing (weeks 9–10) · PLAN §6, §1.5
- [ ] **Two harnesses on one chat model:**
  - DM: everything, plus write tools you confirm
  - Player: player copies and read tools only
- [ ] **New MCP tools:** combat (read, add a combatant, damage,
  conditions), world clock, game module lookup
- [ ] **Statblocks:** from a prompt or a page, saved to the library, with
  "Add to combat"
- [ ] **Agent chat panel** on DM desktop pages and in the DM phone assistant
- [ ] **The player Ask chat** uses the player harness
- [ ] **The audit model labels questions:** scope, intent and type.
  Spoiler hunting goes to the DM.
- [ ] **DM spoiler tags** on pages and topics
- [ ] **A 40-question test set** for spoilers, the villain, stats and
  off-topic questions. No DM text may reach players, and every spoiler goes
  to the DM.
- [ ] Every agent action is in the audit log

## M5: Desktop app and audio (weeks 11–14) · PLAN §12, §3
- [ ] **Tauri desktop app** for Linux, Windows and macOS, wrapping `web/`,
  with a gateway address on the sign-in screen
- [ ] **Native audio:**
  - list every mic and speaker
  - capture several mics at once
  - global hold keys, foot pedals included
- [ ] **Mic modes:** always on, hold to talk, hold to mute, off. Each mic
  has its own key and a "Players' transcript" switch.
- [ ] **Speaker groups:** several devices play the same sound, each with
  its own volume and delay
- [ ] **Consent per player per world,** and a recording indicator on every
  screen
- [ ] **Upload:** Opus chunks to the gateway, with files under
  `audio/<world>/<session>/`
- [ ] **Speech to text** through the audio model, with library and module
  names as hints
- [ ] **Mic merge:** match lines across mics, choose words by clarity,
  credit the closest mic, about 5 seconds of delay
- [ ] **Asides cover every mic for their time span** (fail closed)
- [ ] **Raw audio retention** setting; the backup includes `audio/` and
  `uploads/`
- [ ] **Tests:**
  - three mics give one line each
  - an aside is DM-only on every mic
  - the merge beats the best single mic on the test recording
  - backup and restore round-trip

## M6: Transcript island (week 15) · PLAN §4.1–4.2
- [ ] **A floating island on every page:**
  - drag it, lock it to a corner, resize it
  - opacity 20–100%, colour, text size
  - minimise it to a pill
  - on phones, a bottom drawer
- [ ] **The players' view and the DM's view** of the same transcript; the
  DM can mark a line DM-only afterwards
- [ ] **Keyword highlights** from the game module and library titles, with
  hover cards. Players get player copies only, and no highlight when only a
  DM-only page matches.

## M7: Session log (weeks 16–17) · PLAN §8, §14
- [ ] **A summary draft** from the transcript (without asides), combat,
  loot, coin, the broker and quick events
- [ ] **DM review:** edit by hand, or ask the agent to revise. Versions are
  kept.
- [ ] **A proposed date change** (travel and rests) in the same review;
  travel goes into the log
- [ ] **Approve** runs the leak check (DM-only text and asides), then
  publishes to players and offline
- [ ] **The world calendar** shows sessions, summaries, travel and rests by
  in-world day

## M8: Sound (weeks 18–20) · PLAN §5
- [ ] **Soundboard:** pads, banks, loop, volume and keys; each plays on a
  speaker group
- [ ] **Music board:**
  - the folder tree (area, then sub-genre)
  - the mood map (Combat, Tense, Sneaky, Calm) with crossfades
  - a simple picker
- [ ] **Ambience:** layers (rain, cave, tavern, market, wind, fire) and
  saved scenes, which can be tied to areas
- [ ] **Players' switches** for music, ambience and effects, per device,
  all starting off; the DM sees who has them on
- [ ] **Spotify:** sign-in, event to playlist mapping, plays on your Spotify
  device

## M9: Read aloud (week 21) · PLAN §7
- [ ] **Highlight text, then right-click → Speak,** with a preset picker
- [ ] **Voice presets in settings:** voice, speed, pitch, effect and
  speaker group
- [ ] Sending DM-only text to players' devices asks you first

## M10: Phone apps (weeks 22–23) · PLAN §12
- [ ] **Tauri builds for Android and iOS** of the same app; Capacitor if
  audio falls short
- [ ] **Phone audio:** one mic, a big hold-to-talk button, recording with
  the screen locked
- [ ] **Release builds in CI:** `.AppImage`, `.deb`, `.msi`, `.dmg` and the
  APK. iOS builds on a Mac runner.
- [ ] **"Get the app"** page on the gateway; updates are offered in the app
- [ ] **Sideloading notes** for AltStore and SideStore, a developer account,
  and EU marketplaces

## M11: Hardening (week 24)
- [ ] **A leak test sweep** across every player-facing route, the MCP and
  offline data
- [ ] **A load test:** 5,000 library pages, 6 players live, an 8-hour
  recording
- [ ] **Backup and restore drill** on a fresh server
- [ ] **Docs:** hosting, models, audio setup, modules and the player guide
- [ ] **Fixes** from at least two real sessions

---

## How to work this list
- **One milestone at a time,** with its two tracks in parallel. Each lands
  on `main` with tests, and CI must be green.
- **Show it to you before it's done:** a screenshot page at the end of each
  week, and a check on your Fold for anything phone-related.
- **New ideas go into PLAN.md first,** then get a milestone here. A new idea
  doesn't jump the queue unless you say so.
