# Roll20

GM → Setup → **Roll20** keeps a Roll20 game and an Alexandria world in step.

| What | Roll20 → Alexandria | Alexandria → Roll20 |
|---|---|---|
| HP, max HP, temporary HP of player characters | yes (logged on the sheet as *Roll20*) | yes |
| Conditions | token status markers become conditions | conditions become markers on every token of the character |
| Rolls | open rolls (not whispers or GM rolls) land in the table chat, by the character's player | table chat rolls show in the Roll20 chat (off by default) |
| Handouts | | a library page as a handout: players get their copy, the GM copy goes to the GM notes |
| Chat | | a line from "Alexandria" (or any name) |

Maps are not synced: a Roll20 script can only place images already in the
game owner's Roll20 library.

## Two ways to host

| | With Roll20 Pro | Without Pro |
|---|---|---|
| Install | the Mod script in the game + the bridge | the bridge only |
| Who changes the game | the Mod script, through Roll20's documented Mod API | the bridge, through the Roll20 page's own game data (`window.Campaign`) |
| Rolls, chat lines | yes | yes (read from and typed into the chat) |
| HP, conditions, handouts | yes, on every page | yes, but Roll20 does not document the page data, so an update on their side can break it until the bridge is updated |

The bridge picks the way by itself: it says hello to the Mod script when the
game opens and, with no answer within 8 seconds, works alone ("Alexandria:
Connected (no Mod script)"). The GM page shows which way a game uses.

## How it works

Roll20 has no public API, and its Mod (API) scripts run in a sandbox that
cannot make network calls. So two small scripts carry the data, both served
by Alexandria from the Roll20 page:

1. **The Alexandria Mod script** (`librarian/src/features/roll20/client/alexandria.mod.js`),
   pasted into the game under Settings → Mod (API) Scripts. Only the game's
   creator needs a Pro plan; players need nothing. It is the only thing that
   reads or changes the game.
2. **The bridge** (`alexandria-bridge.user.js`), a userscript for
   Tampermonkey or Violentmonkey in the GM's browser, on the Roll20 tab. The
   downloaded file has the Alexandria address and the bridge key in it.

```
Roll20 game (Mod script) ⇄ Roll20 chat ⇄ bridge (GM's browser) ⇄ Alexandria
```

- Mod → bridge: whispers to the GM, `ALX::<id> <part>/<parts> <base64url JSON>::ALX`,
  sent with `noarchive`; the bridge reads them and hides them.
- Bridge → Mod: hidden API commands `!alx-in <id> <part>/<parts> <base64url JSON>`,
  accepted only from a GM. What the GM was typing in the chat box is put back.
- Bridge → Alexandria: `POST /api/roll20/bridge/{hello,events,sync}` with the
  bridge key (`alx_r20_…`). The key only reaches these three routes; making a
  new key stops the old one. Events carry the Mod's instance and sequence
  number, so a resend is applied once; the Mod keeps events until Alexandria
  acknowledges them (up to 300 while the bridge is away).
- Every 2.5 s the bridge asks `/sync` for what changed in Alexandria.

**Without the Mod** the bridge makes the same events itself (its own instance
id and sequence, kept in the userscript's storage): it compares each player
character's HP attribute, temporary HP and token markers every second, reads
rolls from the chat as Roll20 draws them (`.rollresult`, `.inlinerollresult`;
whispers, GM rolls and the chat history from before it started are skipped),
types chat lines and Alexandria's rolls as `/as "Alexandria" …` (braces and
`[[ ]]` are stripped, so a line cannot run a template or a roll), and makes
handouts with `Campaign.handouts.create` and `updateBlobs`. What it changes
is not reported back.

**No echo.** Each link remembers the numbers both sides last agreed on. A
change from Roll20 is agreed when it arrives, so it is never pushed back;
Alexandria pushes only what changed on its side since. Changes a Mod script
makes fire no Roll20 events, so pushes are not reported back either.

**Linking.** Every character a player controls is listed; it is linked to the
player whose character name (else display name) matches. Change it on the
Roll20 page. On a new link, Roll20 fills in HP Alexandria does not have yet,
then Alexandria's numbers are pushed. *Send Alexandria's HP to Roll20* pushes
everything again.

**HP** comes from the character attribute `hp` (current/max) and `hp_temp`
(the 5e sheets), or a token bar that is not linked to an attribute.

## Settings (world)

| Setting | Default | |
|---|---|---|
| `roll20Hp` | true | HP both ways |
| `roll20Conditions` | true | conditions ↔ markers |
| `roll20RollsIn` | true | Roll20 rolls → table chat |
| `roll20RollsOut` | false | table chat rolls → Roll20 |
| `roll20HpAttr` / `roll20TempAttr` | `hp` / `hp_temp` | attribute names for other sheets |
| `roll20HpBar` | `bar1` | the token bar used when there is no HP attribute |
| `roll20Markers` | `{}` | condition → marker over the defaults (`""` turns one off); a name in the game's custom marker set works too |

Default markers: Blinded bleeding-eye, Charmed chained-heart, Deafened
edge-crack, Frightened screaming, Grappled grab, Incapacitated interdiction,
Invisible ninja-mask, Paralyzed padlock, Petrified white-tower, Poisoned
chemical-bolt, Prone back-pain, Restrained fishing-net, Stunned pummeled,
Unconscious sleepy, Exhaustion tread, Concentrating stopwatch, Dead dead.

## Assistant tools

`roll20_status` (GM read), `roll20_send_handout`, `roll20_say` (GM writes,
approved like any other).

## In the game

GM chat commands: `!alx status`, `!alx sync` (send the character list again),
`!alx reset` (drop waiting events).

## Tests

- `librarian/test/roll20.test.ts`: the real Mod script in a stand-in Mod
  sandbox (`librarian/test/roll20-sandbox.js`), a test bridge and a real
  server.
- `web/e2e/roll20.mjs`: the GM page, the downloaded bridge and the Mod in a
  stand-in Roll20 page in a browser; then a second stand-in game with no Mod,
  where the bridge works alone against page data shaped like Roll20's.

The stand-ins follow Roll20's documented Mod API and the page data and chat
markup community scripts rely on (`#textchat .content`,
`#textchat-input textarea`, `window.Campaign`); none of it is a public API,
so a Roll20 redesign could move it. The Mod way depends only on the chat box.

## What the code relies on

Checked against the Roll20 wiki's Mod API pages (API Sandbox, Chat, Events,
Objects, Utility Functions, Function documentation):

- Mod scripts cannot make HTTP requests, hence the bridge.
- `sendChat(as, text, null, { noarchive: true })` keeps the bridge lines out
  of the chat archive; `/w gm` whispers reach the GM.
- `!` messages arrive as type `api`; `playerIsGM(playerid)` gates them.
- Changes a Mod script makes fire no `change:` events (no echo); a linked
  token bar edited in game fires `change:attribute` (then `change:graphic`).
- Handout `notes`/`gmnotes` cannot be set in `createObj`, only after;
  `inplayerjournals` is `all` or a list of player ids.
- `Campaign().get('token_markers')` is a JSON string of custom markers; the
  Campaign has no name, so the bridge takes the game's name from the tab title.
- `statusmarkers` is a comma list with optional `@n` badges.

Known from community scripts rather than Roll20 docs (the likeliest things to
change): the chat box `#textchat-input textarea` and button
`#textchat-input .btn` (set the value, click), the chat log under `#textchat`
/ `.textchatcontainer`, inline roll tooltips (`title="Rolling … = …"` with
`basicdiceroll` spans), script messages having `playerid` `API`, and, for the
no-Mod way only, `window.Campaign` (reached through the userscript's
`unsafeWindow`).
