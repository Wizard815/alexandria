# Foundry VTT

Alexandria keeps a Foundry VTT world (v12 or v13) and an Alexandria world in
step through one Foundry module, the **Alexandria Bridge**. Alexandria serves
the module itself, so you install it in Foundry by URL.

Code: `librarian/src/features/foundry` (server and `client/alexandria.js`,
the module), `web/src/features/foundry` (GM → Setup → Foundry VTT).

## Set up

1. In Alexandria: GM → Setup → Foundry VTT. Copy the **manifest URL**
   (`<your Alexandria>/api/foundry/module.json`).
2. In Foundry's setup screen: Add-on Modules → Install Module → paste it in
   Manifest URL → Install. Turn the module on in your world.
3. Back in Alexandria, **Make a bridge key**. It is shown once.
4. In Foundry, as the GM: Game Settings → Configure Settings → Alexandria
   Bridge. Paste the Alexandria address and the key. A small
   "Alexandria: Connected" tag shows bottom left.

The address and key are stored in the GM's own browser (client scope), so
players never receive the key. The bridge runs in the active GM's tab: keep
Foundry open while you play. A new key disconnects the old one.

**https:** a browser does not let an https page call an http server. If your
Foundry is on https, Alexandria must be too (Foundry on http and Alexandria
on https is fine).

## What moves

| | Foundry → Alexandria | Alexandria → Foundry |
|---|---|---|
| HP, temp HP | Linked actors' HP lands on the sheet (logged as Foundry) | Sheet and combat changes are written to the actor |
| Max HP | Read from Foundry | Only with "Send max HP too" (in dnd5e it overrides the worked-out max) |
| Conditions | Status effects on the actor → conditions | Conditions → status effects |
| Maps | "Bring into Alexandria": the scene's picture becomes a library map (page under `Foundry/`, level `foundryMapLevel`) linked to the scene | "Make the scene": a map picture becomes a new Foundry scene of its size, linked to the map |
| Tokens | Tokens on a linked scene show on the Map page and table screen, moved live. Hidden tokens are the GM's alone; tokens under fog are never sent to players | The GM drags any token on the Map page; a player drags their own character's token (if "Players move their tokens" is on); the assistant uses `foundry_move_token` |
| Fog of war | Player tokens moving uncover fog around them (`foundryRevealSquares` grid squares; 0 = off) | Alexandria's fog of the linked map picture is drawn over the scene: a tint for the GM, solid for players |
| Rolls | Open rolls in the Foundry chat go to the table chat (not whispers or blind rolls) | Table chat rolls go to the Foundry chat, if on |
| Library pages | | Sent as journal entries: players get their copy, the GM copy is a GM-only page |
| Chat | | Lines from "Alexandria" or a named speaker |

Actors that a player owns (or of type character) are linked to the player
whose character name, or display name, matches. Change a link on the GM page.

Fog lives in Alexandria (the same fog as the Map page). Foundry's own token
vision and fog exploration still work as usual on top of it.

## Settings

`foundryHp`, `foundryConditions`, `foundryTokens`, `foundryFog`,
`foundryRevealSquares` (0-60, default 6), `foundryPlayersMove`,
`foundryRollsIn`, `foundryRollsOut`, `foundryPushMax`, `foundryMapLevel`
(`party` or `dm`), `foundryHpPath` / `foundryMaxPath` / `foundryTempPath`
(actor data paths; dnd5e defaults), `foundryStatuses` (condition → status
id, `""` turns one off).

## Assistant tools

`foundry_status`, `foundry_move_token`, `foundry_send_map`,
`foundry_send_handout`, `foundry_say`. Changes wait for the GM's approval
like any other.

## How it works

- `GET /api/foundry/module.json` and `/api/foundry/module.zip`: the module,
  public (nothing secret in it).
- `/api/foundry/bridge/{hello,events,sync}`: the module's calls, with the
  `alx_fvtt_` bridge key. Open to any origin (CORS `*`, private network
  preflight allowed): the key is the only way in, no cookies.
- The module sends numbered events (actors, scenes, tokens, rolls); the
  server applies each once. Each sync returns HP and status pushes (only
  what changed since both sides last agreed, so nothing echoes), token
  moves, fog states and queued items.
- Tokens are map marks (kind `pin` with `data.token`), so the server's fog
  filter keeps those under fog from players like any mark.

## Tests

- `librarian/test/foundry.test.ts`: the real module in a stand-in Foundry
  (`librarian/test/foundry-stub.js`) against a real librarian.
- `web/e2e/foundry.mjs`: the browser flow (GM page, Map page, a player
  dragging their token on a phone). `FOUNDRY_SHOTS=<dir>` saves screenshots.
- `web/e2e/foundry-real.mjs` (`FOUNDRY_REAL=1`): the assistant with a real
  model drives it.

Not yet tried against a real Foundry server: the module follows the v12/v13
document API (`actor.toggleStatusEffect`, `scene.dimensions`, `FilePicker`,
`Scene.create`), and the fog overlay is a PIXI sprite on `canvas.stage`.
