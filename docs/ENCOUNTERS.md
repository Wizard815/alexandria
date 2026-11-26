# NPC encounters

An NPC walks up to one player and a short talk plays out in that player's
app: the NPC's words, the answers they can pick, a small gift, a shop to
browse, or a quick game of chance. It is for the player the DM is not busy
with right now: they still get something to do, and the DM sees every
word live. DM menu: **Encounters** (Players group). Code:
`librarian/src/features/encounters/`, `web/src/features/encounters/`.

## Sending one (DM)

**Encounters → Send & watch.** Pick one player, several, or everyone, then:

- **Quick line**: an NPC name, what they say, and up to six answers. Leave
  the answers empty for a plain "Farewell".
- **Saved or starter**: one of your saved encounters, or a built-in starter
  (★): a coin-toss gambler, a shell-game hustler, an arm-wrestling dockhand
  (Athletics DC 13), a dice duel, a lost child, and a travelling peddler
  who opens a shop.
- **Shop they can show**: the shop a "show me your wares" answer opens when
  that answer does not name its own. Left on "Any open shop", one open shop
  is picked.

- **Someone from People** fills the NPC's name and look from the People
  list. **Add this NPC to the party's People list** puts a new NPC there
  the first time anyone meets them ("Met by Jessamine").

One NPC at a time: sending to a player who is still talking to someone
closes that older talk ("… wanders off").

While a talk is open the DM's card shows the log, what the player can pick
(and a game's DC), and two controls:
- **Speak as the NPC**: say something new with new answers. The player's
  next answer ends the talk unless you speak again.
- **End the talk.**

## What the player sees

A popup over any screen: who approaches, the talk so far, what the NPC says
now, and the answers. **Later** folds it into a chip in the corner. A
finished talk stays up until they close it, with a **Browse <shop>** button
when the NPC showed them a shop (it opens the Shop page on that shop).

Players get only their own encounters, and of each only the log, the
current line and the answer labels. Where an answer leads, the other steps,
a check's DC and the encounter's coin cap stay on the server.

## Where else encounters show up

- **Table page**: an "Encounters now" card lists who is talking to whom
  while any talk is open, with a link to watch and reply.
- **Players' Encounters page** (More → World): every NPC who has talked to
  that player and what was said, so a clue an NPC dropped is not lost.
- **Recaps**: a session log draft lists who met whom under "People met"
  (never what was said; the talk was between the NPC and one player).
- **Minerva**: with Minerva on, a finished talk is logged to the session in
  progress (DM-only notes): who met whom, what the player answered, and
  what they won or lost.
- **The assistant**: the DM's assistant can list, send, speak in and end
  encounters (tools below).

## Saved encounters

**Encounters → Saved encounters.** An encounter is a set of **steps**. Each
step has what the NPC says and up to six answers. An answer can go to
another step or end the talk, and can carry up to three of:

- **Coin**: a little gold for the player.
- **Item**: a simple item (name and quantity) put in the player's pack,
  noted "From <NPC>".
- **Shop**: opens a shop (a named one, or the one picked when sending).

A step can also hold a **game**, played on the server so the odds are the
odds:

| Game | The player | Wins |
|---|---|---|
| Coin toss | calls heads or tails | 1 in 2 |
| Shell game | points at one of three shells | 1 in 3 |
| Dice duel | rolls 2d6 against the NPC's 2d6 | higher roll; ties go to the NPC |
| Skill check | sends a d20 from real dice (or lets the app roll) plus a modifier | total ≥ the DC |

A game has a **stake** (taken from the player's own coin on a loss; they
cannot play without it), a **win** payout, and the steps a win and a loss
go to. A game step can keep normal answers too, such as "Walk away".

**Draft one with the assistant**: describe the encounter and the world's
chat model (your local model through Argos, usually) drafts the steps,
answers and games. Loose links in the model's draft are repaired (a link to
a missing step ends the talk). Nothing is saved or sent until you do. With
no chat model, you get a plain one-step draft to edit.

Copy a starter to change it. Mark an encounter **Wander** to put it in the
wandering pool.

## Wandering

With **Settings → Players can wander** on, players get a **Wander about**
card on their home page. It starts a random encounter: one of your saved
encounters marked Wander, or the starters while none is. A player can
wander once every **Minutes between wanders** (default 30, 0 for no wait)
and not while already in a talk.

## Keeping gold small

**Most coin one encounter pays out** (default 10 gp) caps gifts and game
winnings per encounter; losses count against it. So "Again!" loops cannot
farm gold. Payouts are logged in the player's ledger ("From Pip",
"Won at coin toss with Pip", "Lost at coin toss to Pip") and need no
approval: the DM wrote the encounter and watches it live.

Settings: `encounterWander` (default off), `encounterWanderMinutes`
(default 30, 0 to 1440), `encounterRewardCapCp` (default 1000 copper, 0 to
100,000).

## Shops

"Open a shop" goes through one function, `resolveShop()` in
`librarian/src/features/encounters/index.ts`: a named shop, else the shop
picked when sending, else any open shop. Only a shop that is open to
players counts; otherwise the NPC "has nothing to sell right now". When
shops gain towns and keepers, this is the one place to pick the keeper's
shop for the player's town.

## API (`/api/worlds/:world/encounters`)

Guests get 403 everywhere.

| | |
|---|---|
| `GET /config` | wandering, its wait, the cap, coin style; players also get `nextWanderAt` |
| `GET /` | DM: the last 60 (`?status=open` for open ones); player: their own last 20 |
| `GET /:id` | one encounter (a player only their own) |
| `POST /` | DM: `{accountIds: [...] \| 'party', templateId \| script \| line + answers, npcName?, npcBlurb?, shopId?, addToPeople?}` |
| `POST /wander` | player: start a random encounter |
| `POST /:id/choose` | player: `{option}`, or `{play: true, pick?, roll?, modifier?}` for the step's game |
| `POST /:id/leave` | player: walk away |
| `POST /:id/say` | DM: `{text, answers?}` |
| `POST /:id/end` | DM |
| `GET/POST /templates/all`, `PUT/DELETE /templates/all/:tid` | DM: saved encounters (`GET` also returns the starters) |
| `POST /templates/draft` | DM: `{prompt}`: a draft from the chat model, not saved |

Live event `encounter` `{id}` goes to the DM and that player; clients
refetch.

MCP tools: `list_encounters`, `list_encounter_templates` (DM),
`send_encounter`, `encounter_say`, `end_encounter` (DM write key).

## NPC voices

Off by default. With `npcVoices` on (a world setting; the assistant's
`set_npc_voices` tool sets it), what an NPC says in an encounter (the
script's lines and the DM's live `say` lines) is read aloud by the voice
model on **that player's device only**: the other players do not hear a
private talk, the table does not play it, and another player cannot fetch
the audio file. The player hears it when one of their devices has the sound
effects switch on.

- The voice: the NPC's own preset (`PUT /voice/npcs {npc, preset}`, or the
  `set_npc_voice` tool; an empty preset takes it away), else the default
  NPC voice `npcVoicePreset`. With neither, the NPC stays silent.
- Each line is spoken once, even after a restart (`voice_spoken`). Lines
  from before voices were turned on are not read.
- Quick events: with `quickEventVoicePreset` set, a new quick event's
  title and prompt are read to the players it went to, once.
- Nothing new is revealed: a voiced line is the text that player already
  sees on screen.

`GET /voice/npcs` (DM) returns the settings and the NPCs with their own
voice. MCP tools: `list_npc_voices` (DM), `set_npc_voice`,
`set_npc_voices` (DM write key).
