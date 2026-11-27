# Files in the library

The GM can upload maps, pictures, PDFs, handouts and item sheets to a world's
library (`librarian/src/features/libfiles`, `web/src/features/libfiles`).

## What can be uploaded

Pictures (PNG, JPEG, GIF, WebP), videos (MP4, WebM, MOV), PDF, plain text and
Markdown, JSON and CSV.
The type is decided from the file's **bytes**, never its name or the type the
browser sent. SVG, HTML, XML, scripts, programs and archives are refused (415),
as are empty files, binary data with a text name, text that is not UTF-8, and
JSON that does not parse. The size cap is 50 MB; change it with
`ALX_LIBFILE_MAX_MB`.

**Videos** have their own, larger cap (2048 MB; `ALX_LIBFILE_VIDEO_MAX_MB`).
They are recognised from the first bytes (an MP4/MOV `ftyp` box, or WebM's
EBML header), streamed to a temp file under `libfiles/.incoming` (never held in
memory) and moved into place; an aborted or refused upload leaves nothing.
Videos are served with HTTP Range support (206, `Accept-Ranges`) from the
file route and from the players' screen, so seeking works. They are not sent to
a source (Kanka, LegendKeeper).

## Videos on the players' screen

A library picture, GIF or video can be queued on the players' screen
(`/w/<world>/screen/players`). The GM's choice to show a file is enough: GM-level
files can be shown, classified ones never. A file players cannot open in the
library is served to the screen only while it is the current, visible item (and
never shows in players' file lists, search or the broker); "Share with party" on
the GM page opens it for real. A video ends its slide when it ends (the screen
reports it to the server, once per version, for the item showing now), unless
the item has "Play for N seconds" or Loop; pictures and GIFs use the slideshow
interval. Browsers play sound only after one click: the screen shows a single
"Click to start" overlay (also full screen) and the desktop app needs none.

Each file has a **kind** (`map`, `handout`, `item`, `rules`, `other`) and a
**level** (`party`, `broker`, `gm`, `classified`). No level means `gm`; a level
that is not one of the four is refused, never defaulted to party.

## Where a file lives

A file belongs to a page: an existing one (`page=<id or path>`) or a new "file
page" made for it (`folder=` and `title=`, the page gets the file's level).
Pictures show inline under the page, PDFs and the rest as View and Download.
The Library side panel has a **Files** tab: every file the viewer may see, with
search. Maps (kind `map`, pictures only) are also offered on the Map page under
"Map from the library".

Players cannot upload (there is no player notes feature to attach files to).

## Who sees a file

A viewer gets a file only when they may see the **page** and the **file's
level**: players party-level files on shared pages, the broker up to broker, a
model acting for the GM up to gm (never `classified`), the GM everything. Lists
and tickets are built per viewer; levels are shown to the GM only. A GM-only
page's files are not found for a player even at party level.

Bytes are served at `/api/media/libfile/<ticket>`. The ticket (the same signed
ticket as sound and stage pictures) names one file and one account, expires
after 12 hours, and the permission is checked again on every fetch, so lowering a
page or file takes it away at once. Files are sent with `nosniff` and
`default-src 'none'`; text is `text/plain`. Files are stored under
`<data>/libfiles/<world>/` (a backup data folder), and are removed with their
page. They are not saved in offline page copies.

## Send to the source (optional)

When the page comes from a source that can take files, the upload form offers
"Also send to <source>". It uses the source's own connection credentials and is
one explicit upload per file (audited as `libfile.send`):

| Source | What is sent |
|---|---|
| Kanka (API token) | `POST /campaigns/{id}/entities/{entity}/entity_assets` (multipart: `name` (cut to 45 characters), `type_id=1`, `visibility_id`, `files`). `visibility_id` is 1 (everyone) for a party file, 2 (admins) otherwise. |
| LegendKeeper (API key) | The v3 API's three-step image upload into the project's asset library: `POST {project api}/assets/uploads` (JSON `contentType`, `contentLength`, `contentHash`), `PUT` the bytes to the signed `uploadUrl` with the headers it names, then `POST {project api}/assets/images` (JSON `uploadKey`, `name`). **Pictures only** (JPEG, PNG, GIF, WebP): a PDF or text file is not offered for LegendKeeper. |

The option is hidden for a `classified` file (never sent anywhere, and a file made
classified later cannot be sent), for mcp-kanka, the LegendKeeper MCP, Markdown
folders, the generic API (it has no upload role) and pages with no source. A
failure is shown on the file ("Not sent to Kanka: ...") with "Try sending again";
the local copy always stays. The remote id is recorded. The upload calls follow the
sources' published API docs (see `docs/API_VERIFICATION.md`) and are tested against fakes only.

## Admin library

Admin > Library (Library group, after Worlds) picks a world and reuses the
Library page. An admin who is **not** the world's GM gets only the party copy
(pages and files shared with the players) and cannot upload: being an admin does
not open a world's secrets. An admin who is the world's GM gets the GM view and
can upload. Routes: `/api/admin/library/worlds` and
`/api/admin/library/worlds/:world/{library,files}`.

## API (world routes, `/api/worlds/:world/files`)

`GET /` (`?page=`), `GET /maps`, `GET /targets?page=&level=` (GM),
`POST /?page=|folder=&title=&name=&kind=&level=&send=<sourceId>` (GM, raw body),
`PATCH /:id`, `DELETE /:id`, `POST /:id/send`, `GET /:id`, `GET /:id/ticket`.
