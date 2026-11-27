# Owlbear Rodeo

Play a casual online session on an [Owlbear Rodeo](https://www.owlbear.rodeo) table with this world's map pictures and fog of war. Alexandria serves the extension itself, so there is nothing else to host or install.

## Set up (GM)

1. **GM → Setup → Owlbear Rodeo.** Copy the extension address, `https://<your Alexandria>/owlbear/manifest.json`.
2. **In Owlbear Rodeo:** your profile → Extensions → *Add Custom Extension*, paste the address, then turn **Alexandria** on for your room.
3. **Make a link key** on the Alexandria page and paste it into the Alexandria button in the room (top-left tools). The key stays in that browser only. It opens nothing but this link: it cannot read pages, sheets or chat.
4. Invite players to the room as usual. They need no key. Their Alexandria button shows which world the table plays in, with a link to open it for their sheet and the party chat.

**Alexandria must be reachable at a public HTTPS address** (the Caddy setup in [HOSTING.md](HOSTING.md), or a tunnel). Owlbear only loads extensions over HTTPS, and every player's browser loads the map picture from your Alexandria. A LAN-only or `localhost` server cannot reach players elsewhere, and Chrome blocks a public site from loading it unless you allow local network access.

## What it does

- **The map.** The Owlbear scene shows the picture on Alexandria's table screen (change the table screen and Owlbear follows), or one you pick. The picture goes in on the Map layer; move and scale it as you like. *Map width in grid squares* sets its size when it is placed (empty: one picture pixel per scene unit).
- **The fog, Alexandria leads (default).** Reveal as you do now: the Map page, the table screen, a scene, by voice. The Owlbear map follows within about two seconds. The fog is one locked fog shape attached to the map, so it moves and scales with it.
- **The fog, Owlbear leads.** Switch in the extension or on the Alexandria page. Alexandria's fog is handed over as an ordinary Owlbear fog shape; from then on, fog and reveal with Owlbear's fog tools, and each change is sent to Alexandria about a second after you stop drawing. The table screen, the Map page and which party marks players see (marks under fog are never sent to them) follow. Each change is one stroke in Alexandria, so *Undo* on the Map page takes the last one back. Switching to Owlbear leads sends nothing by itself, so it never wipes Alexandria's fog.
- **Clear Owlbear's fog** removes Owlbear's own fog shapes (not Alexandria's), for when you go back to Alexandria leading.

## What players can and cannot get

- Only **map pictures the players may already see** are offered (the table screen's rule: the picture's page is shared with them). A GM-only picture on the table screen shows nothing in Owlbear, and the page says why. Unsharing a page takes its picture off Owlbear at once.
- Like any virtual table, Owlbear draws fog **in each player's browser** over the whole picture. Someone who digs into their browser could see the picture under the fog. Alexandria's own map marks are not sent to Owlbear at all.
- The link key never goes into the Owlbear room (players can read room data). The pictures are served at `/api/owlbear/pic/<picture secret>/…`; making a new key changes the secret, so old addresses stop working.

## Limits

- Owlbear's fog **Fill** must be off while Owlbear leads (the extension says so if it is on).
- Owlbear fog comes back at Alexandria's fog resolution (96 × 96 cells over the picture), and Alexandria's fog is drawn in Owlbear as cells (240 across), so curved edges are slightly stepped.
- Owlbear's shapes are read as rectangles, ellipses, triangles, hexagons, closed curves (as polygons) and paths (lines and curves). Not yet tried against a live Owlbear room; the browser test runs the real extension in a stand-in room that speaks Owlbear's SDK messages (`web/e2e/owlbear.mjs`).
- Not synced (yet): tokens and initiative, HP, map marks, more than one map per scene.

## For developers

- Server: `librarian/src/features/owlbear/` (`/api/owlbear/*` with the `alx_obr_` key; GM routes at `/api/worlds/:w/owlbear`; MCP tools `owlbear_status`, `owlbear_link`).
- Extension: `web/owlbear/*.html` and `web/src/owlbear/` (Owlbear SDK 3), built with the web app and served at `/owlbear/`. The background page runs the GM's sync; the popover is the button's panel. A Web Lock keeps one sync per browser.
- Tests: `librarian/test/owlbear.test.ts`, `web/e2e/owlbear.mjs` (`OBR_SHOTS=dir` saves screenshots).
