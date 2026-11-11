# World sources and connectors

Alexandria is meant to manage any D&D world, wherever it lives. Each kind
of source has a **connector**. A connector reads the source (read-only)
and turns what it finds into Alexandria **entries**. Everything after that
is the same for every source:
- storage
- the leak guard
- search
- the Library view
- offline copies
- the information broker
- AI tools

## Connectors that ship

| Connector | Reads | How DM-only content is found |
|---|---|---|
| `legendkeeper-mcp` | LegendKeeper through its MCP server (`api_request` GET only) | Hidden resources, hidden ancestors, hidden documents, `secret` blocks |
| `legendkeeper-api` | LegendKeeper REST v3 with an API key | Same |
| `kanka-api` | Kanka API with a token (`?related=1`, follows `links.next`, waits out 429s) | `is_private` entities, posts not "all"/"members", private attributes |
| `kanka-mcp` | The mcp-kanka server (`find_entities`, `get_entities`) | `is_hidden`. Posts are DM-only unless "trust post visibility" is on. |
| `markdown-folder` | A vault on the server (Obsidian, Lokus, Otterly) | No `visibility: party`; plus `secret:` frontmatter, `> [!secret]`, `%% %%`, `<!-- dm -->`, DM headings |
| `git` | A repo of Markdown reference files, cloned read-only | Same as Markdown |
| `mcp-files` | Any MCP server that lists and reads files (Obsidian MCP and filesystem MCP presets, or name the tools) | Same as Markdown |
| `api` | Any JSON API over HTTP, or any MCP tool that returns records | A visibility field you name; shared only for the values you list |

Older source kinds (`vault`, `kanka`, `mcp` + `profile`) still work; they
map to the connectors above.

## The page model

`librarian/src/intake/model.ts` defines it. An entry has:
- `externalId`: stable within the source. Never the title, because
  titles repeat.
- `parentExternalId`, `folder`: the tree in the Library.
- `title`, `aliases`, `tags`, `type`, `icon` (Font Awesome glyph and
  colour), `banner`.
- `properties`: sidebar fact groups. Each row is a key with rich text.
  `dm: true` marks a whole group DM-only.
- `blocks`: the body. The kinds follow LegendKeeper's document schema, so
  its pages keep their layout:

  | Kind | What it is |
  |---|---|
  | `heading`, `paragraph` | Text |
  | `bulletList`, `orderedList`, `listItem` | Lists, including tasks |
  | `table`, `tableRow`, `tableCell` | Tables |
  | `secret` | DM-only part |
  | `callout`, `toggle`, `blockquote` | Framed text |
  | `codeBlock`, `divider`, `image` | Other content |
  | `infobox` | Floating fact box with a layout and width |
  | `collection` | List of child pages |
  | `unsupported` | Anything else |

- **Inline text** carries bold, italic, code, strike, underline, links,
  and **mentions** (`ref` = the target's externalId, or `name` for
  `[[wiki links]]`).
- `visibility`: `dm` or `party`. Connectors must fail closed: when unsure,
  `dm`.
- `knowledge`: `common` | `local` | `deep`, for the information broker's
  price tiers.
- Markdown sources set `markdown` and `frontmatter` instead of `blocks`.
  The library then runs the Markdown leak guard before parsing.

## How a sync runs

`librarian/src/intake/sync.ts`:

1. A `sync_runs` row is created. The admin panel shows its status, stats
   and log.
2. The connector yields entries. Each is saved with an empty player copy,
   so a running sync never shows a half-checked page.
3. After a **complete** listing, pages the source no longer has are
   removed. A failed or stopped sync removes nothing.
4. Mentions are resolved:
   - by the source's own ids first, then by title or alias
   - a link to a DM-only page, or to a page that wasn't imported, becomes
     "(hidden)" in the player copy
5. Player copies are rebuilt:
   - `secret` blocks, DM/GM callouts, DM headings with their sections, DM
     fact rows and every block kind the guard doesn't know are dropped
   - the Markdown copy (used for search, AI context and downloads) is made
     from the player blocks and redacted a second time

Sources can sync on a schedule (`schedule_minutes`).

## Write a connector

Implement `Connector` from `librarian/src/intake/connector.ts` and add it
to `CONNECTORS` in `librarian/src/intake/registry.ts`:

```ts
export const myApp: Connector = {
  id: 'my-app',
  label: 'My App',
  description: 'Reads a My App world with an API token.',
  fields: [   // the admin panel builds the form from these
    { key: 'worldId', label: 'World id', type: 'text', required: true },
    { key: 'token', label: 'API token', type: 'password', secret: true, required: true },
  ],
  validate(cfg) { if (!cfg.token) throw new ConfigError('API token is required'); },
  async test(cfg, ctx) { /* one small read */ return { ok: true, message: 'Connected.' }; },
  async *sync(cfg, ctx) {
    for (const item of await fetchEverything(cfg, ctx)) {
      yield {
        externalId: String(item.id),
        parentExternalId: item.parent ? String(item.parent) : null,
        title: item.name,
        blocks: markdownToBlocks(item.markdown),
        visibility: item.public === true && ctx.shareVisible ? 'party' : 'dm',
      };
    }
  },
  // For MCP-based connectors: the read tools it may call. Everything else is refused.
  readTools: () => ['list_articles', 'get_article'],
};
```

Rules:
- **Read only.** Never call a tool or endpoint that changes the source.
- **Fail closed.**
  - A missing flag, an entry you couldn't load, an unknown parent: `dm`.
  - Only set `party` when the source itself says players may see it
    **and** `ctx.shareVisible` is on.
- **Keep secrets structured.** Put DM-only parts in `secret` blocks or
  `dm` property groups rather than hoping a text marker survives.
- **Use `ctx.fetch` and `ctx.signal`** so syncs can be stopped and
  tested.
- **Use `ctx.log`** for anything the admin should see in the run log.
- **Add a test** in `librarian/test/` with a fake of the source, including
  a case that proves its DM-only content never reaches a player.

For an app with a JSON API, try the `api` connector first: mapping the
fields in the admin panel may be all you need.
