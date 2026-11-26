# DownTime

DownTime tracks what characters do between adventures: working a job,
research, crafting, training, a legendary vigil, building a stronghold. It is
a house rule (`mods/downtime.alxmod.json`): the DM turns it on under
**House rules**, and its options set the length of a downtime day, whether
players may make new activities, whether the Downtime button moves the world
clock, and whether rewards are given at once.

![The player's popup](screenshots/downtime/2-player-popup-phone.png)

## Tiers

Every activity has a tier, and the tier sets how long it takes unless the
activity says otherwise. The DM changes the lengths on the Downtime page
(Activities) or the House rules page (DownTime activities tab).

| Tier | Default length |
| --- | --- |
| Common | 1 day |
| Uncommon | 3 days |
| Rare | 7 days |
| Very rare | 30 days |
| Legendary | 90 days |

A downtime day is 8 hours of work (an option). An activity can take fewer
hours a day: a *daily* task, such as the Legendary vigil (1 hour a day for a
week) or Study under a master (2 hours a day for three months), fits beside
a bigger one in the same day.

## Activities

- **Ready-made**: about 20 come in the rule file (`presets.downtimePremade`),
  so a DM's own copy of the rule can ship its own list. The DM can change or
  hide any of them per world.
- **The DM's own**: added on the Activities tab, by the assistant, or as a
  one-off when assigning.
- **Players'**: made in the popup. With the default option (`approve`) the DM
  sets its tier and reward first, and the days a player spends on it still
  count while it waits. `free` starts it at once; `off` leaves it to the DM.
- **Codex**: with spell crafting on, every recipe a character does not know
  yet is an activity ("Craft Fire Shield"), its tier by the spell's level.
  Finishing it files the usual learn request in the Codex, so the DM's
  approval, items and mana work as always. "Study a spell" is there for
  MANA's study flow, which reads downtime days from the `downtime-day` event.

## In play

1. When days pass, the DM presses **Downtime** (on the DM's home page, the
   Table, or the Downtime page) and says how many days. The world clock moves
   by that much (an option, undone if the DM takes the round back).
2. Every player gets a popup: their tasks with days on each, **Start
   something** (with **Suggest**, which asks the small helper model for the
   best three for what they want), **Make a new activity** (with **How big is
   it?**, which asks the helper model for the tier and length), or **Skip**.
   The hours have to fit the days. A new pick replaces the old one.
3. The DM sees who picked what and can pick for a player. **Close** ends the
   round (anyone who did not answer is logged as "no pick"); **Take back**
   undoes every pick and puts the clock back.
4. A task that reaches its time is done. Its reward (text, coin, an item, or
   a surprise the player does not see yet) waits for the DM's **Give reward**,
   which puts the coin in the purse, the item in the inventory and a line in
   table chat.

The DM can add or take away time (**＋ day**, **− day**), pause a task, stop
it midway (its work stays in the log), and edit its name, tier, length, hours
a day, reward and a private note at any time.

Every change is in the **log** with the real time, the in-world date, how long
and who did it. Players see their own; the DM sees everyone's. Players can add
a **Downtime** module to their sheet.

## The assistant

The DM's assistant: `downtime` (everyone's tasks and the open round),
`downtime_log`, `downtime_activities`, `downtime_suggest`, and with approval
`downtime_round`, `downtime_close_round`, `downtime_assign`, `downtime_time`,
`downtime_work`, `downtime_update`, `downtime_remove`, `downtime_reward`.
Players' helpers: `downtime`, `downtime_log`, `downtime_activities`,
`downtime_suggest`, `downtime_start` and `downtime_pick` (their own only).

The rank and decide steps use the players' small model (the quick helper's
job when this server has it, else the player job); with no model, a word rule
does the same job and the answer says so (`by: "words"`). Real-model check:
`NODE_USE_ENV_PROXY=1 DOWNTIME_REAL=1 node web/e2e/downtime-real.mjs`.

## API

Under `/api/worlds/:world/downtime`: `GET /`, `GET|POST /activities`,
`PATCH|DELETE /activities/:id`, `GET|POST /tasks`, `PATCH|DELETE /tasks/:id`,
`POST /tasks/:id/time|work|reward`, `GET /log`, `GET /rounds`,
`GET /rounds/current`, `POST /rounds`, `POST /rounds/:rid/pick|close|cancel`
(`current` for the open one), `POST /suggest`, `POST /decide`. Live events:
`downtime`, `downtime-round`, `downtime-done`, and the server event
`downtime-day` for features that count downtime days.
