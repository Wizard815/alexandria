# Macros, key bindings, trigger URLs and lights

The gateway keeps a list of **actions** (next turn, long rest, play a pad, show
a stage card, start recording, run a light scene, roll dice...). A **macro** is
a named list of actions. You can run a macro from a button (DM → Macros), a key,
or a web request. Every run is audited.

All endpoints are under `/api/worlds/:world`:

| Endpoint | What |
|---|---|
| `GET /actions` | the actions you may run, with typed arguments |
| `POST /actions/run` `{action, args}` | run one action |
| `GET/POST /actions/macros`, `PUT/DELETE /actions/macros/:id` | macros (DM) |
| `POST /actions/macros/:id/run` `{args}` | run a macro; a report per step |
| `GET /actions/bindings?scope=web\|app` | your key bindings |
| `POST /actions/bindings`, `DELETE /actions/bindings/:id` | change them |
| `POST /actions/macros/:id/triggers`, `GET /actions/triggers`, `DELETE /actions/triggers/:id` | trigger URLs (DM) |
| `POST /api/trigger/<token>` | the public trigger (no sign-in) |

Macros run with the rights of whoever runs them. Each action lists the roles
that may run it: almost everything is DM-only; players can roll dice. A macro
is DM-only unless you tick "Players may run it", and then it may only contain
player-safe actions.

## Macros

A macro has steps. A step is an action with arguments, an optional wait before
it (up to 10 s), and "carry on if this fails". A failed step stops the macro
and the rest are reported as `skipped`, unless the step says carry on.
A macro can have **parameters** (name, type, default); use `{{name}}` in a
step's argument. Trigger URLs and `run` calls may override only those.

Example, "Combat starts": `lights.scene` Red alert, `sound.mood` x 0.9 y 0.9,
`stage.show` combat, `combat.start`.

## Key bindings

A binding is a key combination for a macro, with a scope: `web` (this web app,
while its tab is focused), `app` (the installed desktop app, which will read
`GET /actions/bindings?scope=app` and register global hotkeys) or `both`.
Combos are stored like `F13` or `Ctrl+Alt+Shift+1`. A plain letter or digit
needs Ctrl, Alt or Meta so a binding never swallows typing.

### A VIA/QMK keyboard

1. Open VIA (usevia.app) and pick your keyboard.
2. On the layer you want, click a key, then the **Any** tab (or "Special") and
   type `KC_F13` ... `KC_F24`. These keys exist on no normal keyboard, so
   nothing else uses them. (Alternatively `LCTL(LALT(LSFT(KC_1)))` for
   Ctrl+Alt+Shift+1.)
3. In Alexandria: DM → Macros → Key bindings → **Press a key**, press the
   key on the keyboard, choose the macro, **Bind**.
4. Keep the Alexandria tab focused for `web` bindings. Global hotkeys, which
   work with another window in front, need the installed app (coming).

On Linux/Wayland some browsers don't see F13+; use the modifier combination.

## Trigger URLs

DM → Macros → Trigger URLs → pick a macro → **Create URL**. The URL is shown
**once**; copy it then. It runs exactly that macro, as you, at most N times a
minute (default 6), until revoked. It can read nothing and open no other
route; the reply says only which steps ran or failed. Treat the URL like a
password.

```
POST https://your-gateway/api/trigger/alx_trg_...
POST https://your-gateway/api/trigger/alx_trg_...?arg=dice=3d6
```

`?arg=name=value` (repeat it for more) overrides a macro parameter; a name the
macro does not declare is refused. A JSON body `{"args": {"dice": "3d6"}}` works too.
Replies: `200` all steps ok, `424` a step failed, `429` too many runs,
`404` unknown or revoked.

**curl**

```
curl -X POST "https://your-gateway/api/trigger/alx_trg_XXXX"
```

**Stream Deck** (Bitfocus Companion, "Generic HTTP" module): add a button,
action *POST*, URL = the trigger URL, no body.

**Home Assistant** (`configuration.yaml`):

```yaml
rest_command:
  combat_starts:
    url: "https://your-gateway/api/trigger/alx_trg_XXXX"
    method: post
```

Then call `rest_command.combat_starts` from a script, dashboard button or automation.

**iOS Shortcuts**: new shortcut → *Get Contents of URL* → the URL → Show More →
Method *POST*. **Android**: HTTP Shortcuts app (or Tasker *HTTP Request*), method POST.

## Lights

DM → Lights. All local-network; secrets (Hue username, Home Assistant token)
are never sent back. Off by default.

- **WLED**: host. Sends `POST http://<ip>/json/state`.
- **Philips Hue** (bridge v1 local API): host, then **Pair**: press the
  bridge's button, then press Pair within 30 seconds. A group is the Hue group number.
- **Home Assistant**: address and a long-lived token (profile page). A group is
  a list of `light.` entities.
- **OpenRGB**: host and port (6742); start OpenRGB with its SDK server on.
  Speaks the SDK packets over TCP and sets each device to one colour. Give each
  group's devices as `index:LEDs` (the LED count is in OpenRGB's device list),
  so no controller data has to be parsed.

Scenes set colour, brightness, effect and fade per group. **Event hooks** (each
off until you turn it on): combat start/end, a player's turn (each player picks
a colour under "My light colour"), a short flash when a player takes damage, a
long rest, music mood (the colour follows the mood map), recording on, a quick
event. Updates are limited to four a second per group (the newest wins) and
are sent without waiting, with a 1 second timeout, so lights never slow the game.

## Hosting note: sound devices on the gateway (not built yet)

Planned: a small audio helper on the gateway that records from a mic and plays
through a speaker plugged into the gateway machine. In Docker that means
passing the sound device into the container (`devices: ["/dev/snd:/dev/snd"]`
on Linux). Nothing in this feature needs it.
