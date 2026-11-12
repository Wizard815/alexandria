# Alexandria plan

The working plan for what comes next. It replaces `docs/PLANNED.md`, most of
which is now built: the Library, the broker, approvals, giving, offline mode.
Each section says what to build, how, and what "done" means.

**Rules that apply to everything below:**
- **Players never see DM-only content.**
  - Every new feature that can show text to players runs the leak check: no
    DM-only line may appear in anything a player receives.
  - Every feature gets a test that proves it.
  - When unsure, it stays DM-only.
- **The gateway owns the data.** Pages, audio, transcripts, uploads, settings
  and logs live in the Alexandria gateway's storage, and the backup covers
  all of it.
- **Sources are pluggable.** Nothing assumes LegendKeeper or Kanka. A feature
  uses what the connected sources provide and quietly does without what they
  don't.

---

## 0. Order of work

| Phase | What | Why first |
|---|---|---|
| 1 | Broker rules: auto-delivery, world-only scope, "Other", source link (§1) | Small, finishes the broker |
| 2 | Item cards linked to library pages (§2) | Small, high value at the table |
| 3 | Intake capabilities: relations, timelines, maps, calendars, push API (§9) | Later features read from it |
| 4 | DM agent with MCP tools, statblocks, combat (§6) | Needed by §7 and §8 |
| 5 | Audio capture, live transcript, storage (§3) | Biggest piece; needs the gateway services |
| 6 | Floating transcript island and game modules (§4) | Uses §3 |
| 7 | Session log: summary, DM review, publish (§8) | Uses §3 and §6 |
| 8 | Soundboard, music board, Spotify (§5) | Independent; can run in parallel with 5–7 |
| 9 | Text to speech with presets (§7) | Small once §3's audio output exists |
| 5–9 | Desktop and phone apps (§12) | Starts with §3: multi-mic and hold keys need the desktop app |

---

## 1. Information broker: finishing touches

### 1.1 Auto-delivery per tier
Today every answer waits until its in-game time is up and the DM can step in.
Add a delivery mode per tier in **World settings → Broker**:

| Tier | Modes | Default |
|---|---|---|
| Common knowledge | Auto / DM reviews | Auto |
| Local lore | Auto / DM reviews | Auto |
| Deep lore | Auto / DM reviews | DM reviews |
| Guarded secrets | **Always DM**; cannot be changed | DM |

- **Auto:** the answer is delivered when its wait is over, with no DM step.
  The DM still sees it in Questions and can correct or refund it afterwards.
- **DM reviews:** it waits in Questions until the DM approves, edits or refuses.
- **"Auto for all tiers"** sets every tier except Guarded secrets to Auto.
- **Done:** tests for both modes; a guarded question is never auto-delivered,
  whatever the settings.

### 1.2 Lock the broker to the world
The broker answers only questions about **the world**. It treats as in scope:
- the world's places, people, history, factions, items and events
- the real-world culture and history the world is built on, which the DM lists
  in settings, for example "Feudal Japan: history, folklore, customs"

Anything else (homework, other games, real-world news) gets an in-character
refusal ("That's not something I deal in.") and costs nothing.

### 1.3 "Other": free questions
A category for questions that are about the game rather than the world:
- **Rules:** "How does grappling work?" Answered from the game module (§4.3),
  such as the D&D 5e SRD, never from memory.
- **Items:** "What does my lantern do?" Answered from the item's own card and
  its linked library page (§2), for items the player can see.

These are free and delivered at once. If there is no rules source for a rules
question, it says so; it does not guess.

"Other" is not a price tier. It doesn't appear in the players' price list or
in the DM's tier settings.

### 1.4 Link to the world's site
- **World settings → Broker:** an optional "World site" link and label, e.g.
  the campaign's LegendKeeper or Kanka page.
- When set, the broker page shows it as a small link spot with no comment
  about it.
- When it's empty, nothing shows.

### 1.5 How questions are judged (the "small decision model")
The goal is that "Who is the BBEG?" never gets an answer. Layers, from the
strongest:

1. **The answering model never sees DM content.**
   - Player answers are built only from player copies and DM-written broker
     notes.
   - A model can't leak what it was never given. This is the real protection,
     and it already holds.
2. **The rule-based check that exists today** compares the question with the
   DM copy.
   - It flags questions whose best match is DM-only text, a DM-only page, or a
     "never sell" page.
   - Flagged questions go to the DM.
3. **New: the audit model** (the small model in §10) labels each question
   with:
   - `scope`: world / real-world-allowed / rules / item / off-topic
   - `intent`: fact / spoiler-seeking / meta-gaming (e.g. "who is the
     villain", "what's the twist", "what's behind the door", "how many HP
     does it have")
   - `type`: who / where / when / why / how / price
   - its confidence

   The model only routes:
   - spoiler-seeking or meta-gaming questions go to Guarded secrets (the DM
     decides)
   - off-topic questions are refused
   - when it isn't sure, the question goes to the DM

   It never decides to reveal anything, and it has no access to DM text.
4. **DM spoiler tags.**
   - The DM marks pages or topics as spoilers, e.g. the villain's page, or
     "the Heart's true owner".
   - Questions that name them are always Guarded, whatever the model says.
5. **A final output check.** Before any answer is delivered, it is compared
   with all DM-only text. Any overlap blocks it and sends it to the DM. This
   leak check exists today; it stays on every path.

**Why this way:** a model told "don't reveal secrets" while holding the
secrets can be talked into revealing them. Keeping DM text out of its input
means there's nothing to talk it out of. The small model is cheap and fast,
and it only chooses between "answer", "ask the DM" and "refuse".

**Done:** a test set of at least 40 questions, including villain, twist,
stats and off-topic questions, where no player-facing output contains DM-only
text and every spoiler question goes to the DM.

---

## 2. Item cards linked to library pages

- **Linking:** an item can link to a library page from any source. The
  item's edit form searches pages by title. Links to LegendKeeper or Kanka
  pages resolve to the synced copy.
- **The card shows:**
  - name, picture, quantity, weight, owner and notes
  - from the linked page: its sidebar facts and opening section, with
    "Open page"
- **Players see only the player copy.**
  - If the linked page is DM-only, players see the item's own notes and
    nothing from the page.
  - The DM sees everything, with secrets marked.
- **Opening it:**
  - **Mouse:** hover over the item for 3 seconds and the card pops out next
    to it. The pointer can move into the card, and the card scrolls when it
    is long. It closes when the pointer leaves both the item and the card,
    or with Esc.
  - **Touch:** an ⓘ button on each item opens the same card as a bottom sheet.
  - **Keyboard:** focus the item and press Enter.
- **Delay:** 3 seconds, a per-user setting from 0.5 to 5 seconds.
- **Updates:** when the source page changes on sync, the card shows the new
  text. Nothing is copied into the item.
- **Done:**
  - works on the inventory, party, approvals and broker screens
  - a test that a link to a DM-only page shows no page text to players

---

## 3. Audio capture and live transcript

### 3.1 Microphones and speakers

**The DM's computer can use any number of mics and speakers at once.**

**Mics:**
- **Audio setup** lists every input device on the DM's computer. The DM
  turns on as many as they want and names each one, e.g. "Table", "DM
  headset", "Player laptop corner".
- Each mic has its own mode:

  | Mode | What it does |
  |---|---|
  | Always on | Records the whole session (e.g. the table mic) |
  | Hold to talk | Records only while its key or button is held (e.g. a headset used for DM-only lines or NPC voices) |
  | Hold to mute | Records all the time except while held (a cough button) |
  | Off | Not used this session |

- **Each hold key is set per mic.** Two mics can share a key, and a key can
  be a keyboard key, a mouse button, a foot pedal (which shows up as a key)
  or a button on screen.
- **Each mic can be marked "DM aside"** (§3.2), e.g. a headset whose hold
  key is the aside key. Everything from it is DM-only.
- **Every mic is its own track.** That tells the transcript who is speaking
  without guessing.
- **Players:** one mic each, from the app or a browser, with the same three
  modes. A player's mic always records as that player.

**Speakers:**
- **Audio setup** lists every output device. The DM groups them into
  **speaker groups**, e.g.:
  - "Table": the living-room speaker and the soundbar, both playing the same
    sound
  - "DM ears": the DM's headphones only
- **Each sound source picks a group:** music (§5), soundboard pads (§5.1),
  read-aloud (§7) and previews.
- A group plays the same audio on all its devices at once. Each device keeps
  its own volume and a small delay setting to line up speakers that lag
  (Bluetooth).
- **Remote players** can be a target too: the sound is streamed to their
  app.

**Settings are saved per computer**, so the DM's setup comes back next
session. A missing device (unplugged) is shown greyed out, not forgotten.

**How it connects:**
- **The desktop app (§12)** captures every mic natively and plays to every
  speaker at once. Hold keys work even when Alexandria isn't the focused
  window.
- **In a browser,** several mics and speakers also work in Chrome and Edge,
  but hold keys only work while the Alexandria tab is focused. Safari and
  Firefox can't pick output devices.
- **Upload:** audio is sent to the gateway as Opus chunks (5–10 s) over
  HTTPS.

### 3.2 Consent and privacy (agreed)
- **Each player agrees to recording once per world,** and can stop at any
  time. Without consent, their mic is never captured.
- **A clear "Recording" indicator** shows on every screen while a session
  records.
- **DM aside:** a hold-to-talk key that keeps a stretch of DM speech out of
  the players' transcript, for spoken secrets. It works on any DM mic. A mic
  can also be marked "always aside" (§3.1).
  - Aside segments are DM-only, like a secret block.
  - The session summary (§8) treats them as DM-only.
- **Retention:** the DM sets how long raw audio is kept (e.g. 30 days).
  Transcripts are kept until deleted.
- Recording laws differ by place. The consent step exists so everyone at the
  table agrees.

### 3.3 Speech to text
- **A transcription service runs next to the gateway** as its own container.
  Two options:
  - local: faster-whisper or whisper.cpp
  - hosted: any OpenAI-compatible `/v1/audio/transcriptions` endpoint
- **Live:** each chunk is transcribed as it arrives and shown within a few
  seconds.
- **After the session:** a second, more accurate pass over the whole
  recording replaces the live text in the session record.
- **Word lists:** names from the library (titles and aliases) and from the
  game module are sent as hints, so "Velmira" and "Saltmarsh" come out right.

### 3.3a One transcript from many mics
At a table, several mics hear the same words: the table mic, the DM's
headset and a player's phone. The transcript shows each spoken line once, in
its best version.

**How it works:**
1. **Transcribe each mic separately.** Each line keeps its start and end
   time, the words with their confidence, and the mic's signal level.
2. **Find lines from different mics that are the same speech:** they overlap
   in time and their words are mostly the same.
3. **Choose the best version of each line,** going word by word. Each word
   comes from the mic that heard it most clearly: highest confidence and
   strongest signal. Where the mics disagree, the clearest mic wins.
4. **Credit the speaker from the closest mic.** The mic with the strongest
   close signal says who spoke. A player's own mic beats the table mic for
   that player's voice.
5. **Show it with about 5 seconds of delay.** That gives every mic's version
   time to arrive. A line can be corrected a moment later if a clearer
   version comes in.

**Asides cover every mic.** While the DM aside key is held, everything every
mic hears in that time is DM-only. The table mic and players' phones also
hear what the DM says into the headset, so this works on time, not on which
mic was used. It fails closed: a line that overlaps an aside even partly is
DM-only.

**Done:**
- A test with three mics recording the same speech shows each line once.
- The word-level merge beats the best single mic on a test recording.
- A line spoken during an aside is DM-only on every mic.

### 3.4 Storage
- **Audio** is stored as files under `ALX_DATA_DIR/audio/<world>/<session>/`.
  Large files don't belong in SQLite.
- **Transcript segments** are stored in the database: session, speaker, mic,
  start and end, text, aside flag and revision.
- **Backups cover everything:**
  - the admin backup downloads one archive: the database plus `audio/` and
    `uploads/`
  - `deploy/backup.sh` keeps the archives
- **Done:**
  - two-tab test: DM and player mics produce one transcript with the right
    speakers
  - aside segments never reach a player
  - backup and restore round-trip

---

## 4. Floating transcript island

### 4.1 The island
- **A small floating window that follows every page,** for the DM and the
  players. It shows the live transcript as word bubbles, newest at the
  bottom, with the speaker's name or colour.
- **Its controls are per person and remembered on that device:**
  - drag it anywhere, or lock it to a corner
  - resize it
  - opacity from 20% to 100%, where 100% is fully solid
  - bubble colour and text size
  - minimise it to a pill showing the last line
- **Players see the live transcript too** (decided). It's the same merged
  transcript (§3.3a) without asides, about 5 seconds behind. The DM sees
  everything, with asides marked.

### 4.2 Highlighted key words
Words from the game module and the world are highlighted in the bubbles:
- spells, conditions, monsters and rules terms
- library page titles

Hovering over a highlighted word, for the DM **and players**, shows the
same card as §2 for library pages, or the module's entry for a rules term.
It follows the same rules: players see only player copies, so a word that
matches only a DM-only page isn't highlighted for them at all.

### 4.3 Game modules (rules)
- **Two come with Alexandria, and the DM picks one per world:**
  - **D&D 2024**, from SRD 5.2. This is the default for new worlds.
  - **D&D 5e (2014)**, from SRD 5.1.

  Both are published under CC-BY-4.0, and the credit line is shown in the
  app.
- **A module is a package:**
  - a glossary: term, kind and short text
  - optional rules sections for the broker's "Other" answers (§1.3)
  - optional monsters and a statblock format for the DM agent (§6)
- **Importing more is simple:** World settings → Game module → **Import**, then
  any of:
  - a `.zip` or a folder of Markdown files, one term per file, with frontmatter
    `kind: spell | condition | monster | rule | item`
  - a JSON file in the module format, documented in `docs/MODULES.md`
  - a git repo or a JSON API, through the same connectors as world sources
    (e.g. an Open5e-style API)

  Imports show a preview (counts per kind and a few samples) before
  they're saved.
- **More than one module can be on at once,** e.g. D&D 2024 plus a homebrew
  pack. Where terms clash, the DM's order decides which wins.

---

## 5. Soundboard and music board (DM)

### 5.1 Soundboard
- A grid of effect pads: door creak, thunder, sword clash. Each pad has its
  own volume, loop option and optional key shortcut.
- Sounds are uploaded to the gateway and grouped into banks.
- Each pad plays on a speaker group (§3.1), on players' devices (§5.3), or
  both.

### 5.2 Music board: local files
The music library is a **folder tree on the gateway**:

```
music/
  village/            ← area or setting (top-level folder = type)
    market/           ← sub-genre for finer themes
  dungeon/
  demon/
  combat/
```

**The mood map:**
- **A square with four corners:** Combat, Tense, Sneaky and Calm.
  - Each track has a spot on it.
  - The DM drags a marker. The board plays the nearest tracks from the
    chosen area and crossfades when the marker moves to a new region.
- **A track's spot comes from one of:**
  - its folder name (e.g. `combat/` sits in the Combat corner)
  - a `moods.yaml` next to the files
  - the DM dragging tracks onto the map
- **Area chips** (village, dungeon, demon…) narrow which tracks it picks.
- **A simple picker** (folders, then tracks, then play) sits next to the
  map, for when you just want a song.
- **Where the music plays:** on a speaker group (§3.1), and on players'
  devices when they allow it (§5.3).

### 5.3 On players' devices (players choose)
- The DM can send music and sound effects to players' devices, streamed
  through the gateway.
- **Each player decides, per device, with two separate switches:**
  - **Play the DM's music**
  - **Play the DM's sound effects**
- Both start **off**. Each has its own volume. A player can turn either off
  at any time, even mid-session.
- The DM sees who has each one on, so they know who hears what.
- At the table, players usually leave both off and hear the room speakers.
- Spotify music is never sent to players (§5.4).

### 5.4 Spotify (simple)
- The DM connects a Spotify account in settings, using Spotify's own sign-in.
- The DM maps **events to playlists**, e.g. Combat → "Boss Fights" and
  Tavern → "Folk".
- Picking an event plays a matching playlist on the DM's Spotify device.
- **Limits:**
  - It needs Spotify Premium, and only plays on the DM's own Spotify devices.
  - Spotify doesn't allow streaming its music to players.
  - So remote players hear only local-file music.

**Done:**
- the mood map moves between tracks with crossfades
- the soundboard plays on the table output
- Spotify event mapping starts the right playlist

---

## 6. DM agent (LLM)

A chat panel for the DM, available on every DM page, connected to everything
the DM can see and do.

### 6.1 What it can use
- **Alexandria's MCP tools with the DM's write key:** library, people,
  calendar, inventory, coin, quick events, broker, approvals. Add new tools
  for:
  - combat: read initiative, turn, HP, effects; add a combatant with a
    statblock; apply damage or conditions
  - the live transcript
  - the session log
  - the soundboard and music
  - text to speech
- **The world's own sources through their MCP servers,** e.g. LegendKeeper
  and Kanka.
  - Read-only by default.
  - Writing back to a source is a separate, off-by-default switch per source.
- **The game module (§4.3),** for rules and statblock formats.

### 6.2 What it does
- **Answers live questions** ("What did Velmira say last session?", "What's
  the DC for this?"), citing the page or transcript it used.
- **Builds statblocks** from a prompt or a library page, in the module's
  format.
  - Statblocks are saved to the library.
  - "Add to combat" puts the creature in initiative with its HP and AC.
- **Reads combat:** whose turn it is, HP, effects and concentration, and
  suggests monster actions.
- **Drafts and revises the session summary** with the DM (§8).

### 6.3 Safety
- Any action that changes something shows what it will do, and the DM
  confirms it. A DM setting can auto-approve read-only actions.
- Every tool call is in the world's audit log.
- **One chat model for everyone** (§10). The DM and the players talk to the
  same model in different harnesses:

  | | DM harness | Player harness |
  |---|---|---|
  | Context | Everything: DM copies, transcript with asides, combat | Player copies, broker notes, the player's own items and notes |
  | Tools | All MCP tools, including writes (confirmed) | Read tools only, scoped to that player's key |
  | Output | As is | Leak check before it is shown |
  | Broker | Prices and answers anything | Goes through the audit model and the price tiers first |

  The harness decides what the model is given and what it may do. The
  player harness never puts DM text into the model's input, so the same
  model can't leak it.

**Done:**
- the agent makes a statblock from a page and adds it to combat
- it answers from the transcript with a citation
- every write is confirmed and audited

---

## 7. Text to speech

- **Highlight text anywhere in the DM's view, right-click and choose Speak.**
  This works on library pages, the agent's replies and the transcript.
- **A small menu picks a preset:** narrator, old man, villain…
- **Presets live in World settings → Voice:**
  - voice, speed and pitch
  - an effect: none, echo or radio
  - where it plays: table output, players' devices, or both
- **Speech is made by Kokoro** (open model, runs as a small container with an
  OpenAI-compatible `/v1/audio/speech` endpoint), or any compatible TTS
  endpoint.
- **What it reads:** only the highlighted text. If it contains DM-only text
  and is sent to players' devices, the DM is asked to confirm first.

---

## 8. Session log

- **A Session log page for players and the DM,** one entry per session.
- **After a session the agent drafts a summary** from:
  - the transcript (without asides)
  - combat results, loot and coin changes
  - broker purchases and quick events
- **The DM reviews the draft before anyone else sees it.** The DM can:
  - edit it by hand
  - ask the agent to change it ("Add that they found the map", "Remove the
    part about the door")
  - mix both
- **Approve publishes it to players.**
  - Before publishing, the leak check compares it with DM-only text and with
    asides, and shows any overlap.
  - Versions are kept. The DM can un-publish or revise later.
- **Players see only approved summaries.** The DM sees drafts too.

**Done:**
- a draft is created from a recorded test session
- an aside line in the transcript is caught by the leak check
- a published summary appears for players and offline

---

## 9. Intake: everything is a connector

Alexandria takes whatever a source offers and uses only that.

### 9.1 Capabilities
- **Each connector declares what it provides:**
  - `pages`, `properties`, `tags`, `images`
  - `relations`, `timelines`, `maps`, `calendars`
  - `items`, `characters`, `statblocks`
  - `modules` (glossaries, rules)
- **Features read from the capabilities:**
  - The **Relations** page shows relations from any source that has them
    (Kanka does; LegendKeeper doesn't), plus ones the DM adds by hand.
  - If no source has timelines, the timeline view shows only the DM's own
    events.
  - A missing capability never causes an error. The feature shows what it
    has.
- **To build:**
  - Kanka relations, timelines, calendars and map markers
  - LegendKeeper maps, timelines and boards (as pages with their own block
    kinds)
  - the visibility rules for each, written fail-closed

### 9.2 Push intake API
For tools that can't be polled, a DM or admin creates a **source key**, and
the tool pushes entries to `POST /api/intake/<source>/entries`.
- Entries use the same entry format as connectors (`docs/CONNECTORS.md`).
- They go through the same leak guard.
- The key can only write to that one source.
- Webhooks from apps that send them, such as a git push, trigger a sync.

### 9.3 Modules as sources
Game modules (§4.3), music folders (§5.2) and sound banks (§5.1) are imported
with the same connector system and run log.

---

## 10. Models (64 GB of VRAM, all local)

Five model jobs. Each is served locally and reached through the gateway's
`/v1` endpoints, so any of them can be swapped later.

| Job | Used for | Size class | Example (pick current versions when building) | Approx. VRAM |
|---|---|---|---|---|
| **Chat** | DM agent, player Ask, broker answers, session summaries | 27–32B, 4–6 bit | Qwen3 32B, Gemma 3 27B, or a 30B mixture-of-experts model for speed | 20–26 GB + context |
| **Audit** | Broker routing and spoiler checks (§1.5), "is this in scope", second opinion on summaries | 3–4B | Qwen3 4B, Gemma 3 4B | 3–5 GB |
| **Audio** | Speech to text (§3.3) | Whisper large-v3 class | faster-whisper or whisper.cpp with large-v3-turbo | 3–6 GB |
| **Voice** | Text to speech (§7) | Small | Kokoro-82M | under 1 GB |
| **Extra** | Library embeddings for better search and broker matching | Small | bge-m3 or similar | 1–2 GB |

That is about 30–40 GB loaded together. The rest is for the chat model's
context (long transcripts need it) and for a larger model or quant later.

**How they run:**
- **Chat and audit:** in **Argos**, which runs llama-server models on shared
  GPUs and serves `/v1`.
- **Speech to text:** a whisper server container.
- **Text to speech:** a Kokoro container with `/v1/audio/speech`.
- **Docker examples:** `deploy/examples/` gets ready-made override files for
  each.

**Admin → Models** maps each job to an endpoint and model name. If a job has
no model:
- with no audit model, questions use the rule-based check only and anything
  unsure goes to the DM
- with no audio model, there is no transcript

## 11. Settings this adds

- **World settings:**
  - Broker: per-tier delivery mode, allowed real-world topics, spoiler topics,
    world site link
  - Game module
  - Recording: consent text, raw-audio retention, who can see the live
    transcript
  - Audio setup (per computer): mics and their modes and hold keys, speaker
    groups
  - Voice presets
  - Music folders and Spotify account
- **Per person, on their device:** transcript island position, size,
  opacity and colour; item card hover delay.
- **Server (admin):**
  - transcription endpoint
  - TTS endpoint
  - the five model jobs (§10)
  - storage limits for audio
- New settings that change behaviour get a short guide in `docs/` with a
  working example. Docker examples go in `deploy/examples/`: whisper,
  Kokoro and Ollama next to the gateway.

---

## 12. Apps and platforms

Not going to app stores: everything is installed directly (sideloaded).

| Platform | App | Notes |
|---|---|---|
| Linux, Windows, macOS | **Desktop app** (Tauri) | DM and players. Needed for many mics and speakers, global hold keys and offline use |
| Android | **Phone app**, installed from an APK | Players, and the DM away from the table |
| iOS | **Phone app**, sideloaded | See below |
| Any browser | The web app | Works everywhere with no install. Fewer audio features. |

**One app, everywhere:**
- All of them run the same React app from `web/`, so a screen is built once.
- **Desktop:** Tauri wraps it and adds a native audio module for multi-mic
  capture, multi-speaker playback and global hold keys.
- **Phones:** use Tauri 2's iOS and Android builds of the same app, rather
  than a separate React Native app. The old Expo skeleton in
  `scribes/mobile` is dropped.
  - If Tauri mobile falls short on audio, fall back to Capacitor, which also
    wraps the same web app.
- The old skeletons in `scribes/` are replaced by this.

**Phones:**
- **One mic, with hold to talk** as a big on-screen button.
- **Recording keeps going with the screen locked:** iOS needs the app's
  background-audio permission for that, and Android a foreground-service
  notification.
- **Offline copies** use the same saved data as the web app (already built).
- **The transcript island (§4)** becomes a bottom drawer.

**Sideloading:**
- **Android:** download the APK from the gateway's own page and allow
  installing it. Updates are offered in the app.
- **iOS:** there are three ways, and the plan supports all of them:
  - **AltStore or SideStore with a free Apple ID.** The app has to be
    refreshed every 7 days; those tools do it automatically on the same
    Wi-Fi.
  - **A paid Apple Developer account ($99 a year).** Builds last a year, but
    only on devices added to the account.
  - **In the EU, an alternative app marketplace.**
- **Without installing anything,** the web app still works on both phones
  from the browser, including offline. Recording then only runs while the
  page is open and the phone is unlocked.

**Builds:**
- A CI job builds the desktop installers (`.AppImage`/`.deb`, `.msi`,
  `.dmg`) and the Android APK.
- The iOS build needs a Mac, or a CI Mac runner.
- The gateway hosts the files under **Get the app**.

**Done:**
- The desktop app records two mics with different hold keys and plays music
  on a two-speaker group.
- The Android APK records with the screen locked.
- An iOS build installs with AltStore.

## Decisions

1. **Live transcript for players:** yes, with key-word cards. It's built from
   all mics, merged into the best version of each line, about 5 seconds
   behind (§3.3a, §4).
2. **DM music and sound on players' devices:** yes, if each player allows
   it, with separate switches for music and sound effects (§5.3).
3. **Rules:** D&D 2024 (SRD 5.2) by default and D&D 5e 2014 (SRD 5.1) also
   built in; more can be imported from a zip, a folder, JSON, git or an API
   (§4.3).
4. **Models:** all local (§10).
