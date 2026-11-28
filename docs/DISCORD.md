# Discord

A world can have a bot in the table's Discord server. It:

- posts a **session recap** to a channel the moment the GM publishes it;
- posts **dice rolls** from the table chat to a channel (never the party chat, and a roll the GM hides comes down again);
- sends each player their **broker messages** as Discord DMs: an answer that is ready, a price the GM named, and the GM's special offers (the teaser and price only; the information stays in the app until someone pays);
- lets linked players use slash commands: `/roll`, `/ask` (their Squire), `/recap`, `/link`, `/unlink`.

Nothing GM-only is posted. Everything the bot sends is something the players
already see in the app, and commands run as the linked account with its role
checked on every call.

The code is `librarian/src/features/discord` (server) and
`web/src/features/discord` (GM page and the player's link page).

## Set it up (GM)

1. Go to <https://discord.com/developers/applications>, make an application, open **Bot**, press **Reset Token** and copy the token. No privileged intents are needed.
2. In Alexandria open **GM → Setup → Discord** and paste the token.
3. Paste your server id (in Discord: Settings → Advanced → Developer Mode, then right-click the server → Copy Server ID). The bot starts and the page shows "Connected as …".
4. Press **Invite the bot** and add it to the server. The slash commands appear in that server within a few seconds.
5. Pick the recaps channel and the dice channel, and press **Send a test**.

The token stays on the Alexandria server; the page never shows it again (only
its last four characters). Several worlds may share one bot as long as each
uses its own Discord server. The bot needs View Channel, Send Messages, Embed
Links and Read Message History in the channels it posts to; the invite link
asks for those.

The bot connects out to Discord (the gateway and the REST API), so it works
behind a home router with nothing to open. Set `ALX_PUBLIC_URL` and the
messages link back to the right page of the app.

## Link a player

The player opens **Settings & account → Discord**, presses **Get a link
code** and types `/link code:ABCD2345` in the server. A code works once and
lasts 10 minutes; five wrong codes in ten minutes lock that Discord account
out of /link for a while. `/unlink` in Discord, **Unlink** on the player's
page, or **Unlink** on the GM's page undoes it. A player who leaves the world
can do nothing more through the bot.

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/roll dice:2d6+3 sneak attack` | linked player or GM | Rolled on the Alexandria server. While a session runs it goes into the table chat as that player (and the GM sees it like any roll); with no session it is only answered in Discord. Same dice syntax as the table chat (`kh`, `kl`, `dh`, `dl`). |
| `/ask question:… task:…` | linked player | Their Squire, the quick helper (the small `helper` model), in the name and personality the player gave it. Tasks: answer, rules, my turn, sum up my character, what next, story so far. Only the player sees the answer unless they set `share`. Questions about the world go to The Broker, with a link to it. |
| `/recap` | linked player or GM | The last published recap, privately unless `share`. |
| `/link code:…`, `/unlink` | anyone in the server | Link or unlink a character. |

The GM keeps priority on the local models: `/ask` goes through the same model
queue as the app, so when the GM's assistant needs the model, a player's
question waits or is told to ask again in a moment.

## What goes wrong

- **"Discord did not accept the bot token."** The token was reset or mistyped. Reset it again and paste the new one.
- **"The bot is not in that server yet."** Press Invite the bot.
- **"The bot cannot see that channel" / "is missing a permission".** Give the bot's role View Channel and Send Messages in that channel.
- **A player gets no broker DMs.** Their Discord privacy setting blocks DMs from server members; the error shows on the GM page.
- **No slash commands.** The bot registers them when it joins or starts; if you changed the server id, they come within a few seconds of saving.

## Tests

- `librarian/test/discord.test.ts` runs the bot against a stand-in Discord (`test/discord-fake.ts`: REST plus a small WebSocket gateway).
- `web/e2e/discord.mjs` drives the GM page and the player's link page on the demo world against the same stand-in. With `DISCORD_HELPER_URL=https://openrouter.ai/api/v1` (and `_KEY`, `_MODEL`, default Bonsai 2 9B) `/ask` uses a real small model. Run from `web/`: `npm run build && node --experimental-strip-types e2e/discord.mjs`.
