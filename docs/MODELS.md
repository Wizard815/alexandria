# Models

Alexandria uses six model jobs (five, plus an optional rerank). In
**Admin → Models** you add **providers** (places models live: Argos, OpenAI,
Ollama, LM Studio, or any OpenAI-compatible server), then each job picks a
provider and a model name, and may name a fallback. Features only reach
models through `librarian/src/core/ai.ts`, so swapping a model never touches
a feature.

## The jobs

| Job | Used for | Endpoint on the server |
|---|---|---|
| **chat** | DM agent, player Ask, broker answers, session summaries. Also the `/v1/models` and `/v1/chat/completions` passthrough. | `POST {base}/chat/completions` |
| **audit** | The small model: question routing, spoiler checks, second opinions | `POST {base}/chat/completions` |
| **audio** | Speech to text | `POST {base}/audio/transcriptions` |
| **voice** | Text to speech (Speak menu, narration) | `POST {base}/audio/speech` |
| **extra** | Embeddings for library search and broker matching. Also the `/v1/embeddings` passthrough. | `POST {base}/embeddings` |
| **rerank** | Optional. Reorders the top 20 library search results and the agent's library matches. | `POST {base}/rerank` |
| **helper** | Optional. The players' quick helper: a small second model (4B or less, under about 6 GB) for rules lookups, turn options and sheet summaries. Unset: the Players model, then Chat. See [The players' quick helper](#the-players-quick-helper-a-small-second-model). | `POST {base}/chat/completions` |

### Providers

A provider is `{ id, name, kind, baseUrl, apiKey, location }`:

- **kind**: `argos`, `openai`, `ollama`, `lmstudio` or `openai-compatible`.
  It sets the defaults (a bare address gets `/v1`) and little else.
- **Base URL**, ending in `/v1`. Paste it with or without `/v1` for Argos,
  Ollama, LM Studio and OpenAI.
- **API key**, optional, sent as `Authorization: Bearer <key>`. It is stored
  on the server and never sent back: the page shows `••••`, and saving with
  `••••` keeps the stored key. Clear the box to remove it.
- **location**: `local` (your own machines) or `cloud` (a third party).
  OpenAI defaults to cloud; Argos, Ollama and LM Studio to local; an
  "other" provider is guessed from its host (a private address or a
  single-word name is local) and you can change it. Location only matters for
  fallback, below.

### Jobs

Each job is `{ providerId, model, options, fallback? }`:

- **Provider** and **model name** (sent as `model` in every request).
- **Extra options**, a JSON object merged into every request, e.g.
  `{"voice":"af_heart"}` for the voice job.
- **On/off.** Off, or no provider, means "use the server's environment".
- **Fallback**, optional: another provider and model (see below).
- **During a game session**: Keep loaded or Load when needed (see Game
  night below), **Warm up** and the loaded/unloaded status.

A job with nothing saved falls back to the environment:
`ALX_MODEL_<JOB>_URL`, `ALX_MODEL_<JOB>_MODEL`, `ALX_MODEL_<JOB>_KEY`
(`<JOB>` is `CHAT`, `AUDIT`, `AUDIO`, `VOICE`, `EXTRA`, `RERANK`, or a part
of chat with a model of its own: `DM`, `PLAYER`, `BIBLE`, `HELPER`), then
`MODEL_BASE_URL` / `LOCAL_LLM_URL` and `MODEL_API_KEY`. With neither, the job
has no model, and features that need it fall back or stay off. Rerank is only
switched on by `ALX_MODEL_RERANK_URL` (not by `MODEL_BASE_URL`), because not
every server has a rerank endpoint.

**Settings from before providers** (a base URL and key on each job) are
turned into providers once, automatically, when the librarian starts: one
provider per distinct base URL (a second one only if two jobs used different
keys for it). Nothing for you to do; the jobs keep working as they were.

**Test** runs a tiny real call: a one-word chat, a half second of silence for
audio, a short phrase for voice, one sentence for embeddings, two short
documents for rerank. It shows ok or the error, the time it took and a short
sample. Save first; Test uses what is saved, and only the main provider
(**Test fallback** tries the fallback).

### Fallback

Give a job a fallback provider and model, and when the main provider cannot
answer, the call is retried once on the fallback. It falls back on:

- no connection, or a timeout;
- a 5xx, including a 503 while the model loads;
- a model that is unloaded or not found (404, or a server that says "no
  models loaded").

It never falls back on a 4xx about the request itself (400, 401, 403, 422,
429): a bad request would fail the same way elsewhere, and a wrong key should
be fixed, not hidden. A streamed chat answer only falls back if it fails
before any text has reached the screen. A request refused because it repeats
classified text is never retried anywhere.

**Local to cloud needs an explicit switch.** If the main provider is `local`
and the fallback is `cloud`, tick **Allow falling back to the cloud** on that
job. Until then the fallback is saved but never used, and the page says so.
Turning it on means world text will leave this server whenever the local
model fails (it is written to the audit log). The classified guard in
`core/ai.ts` screens every attempt, the fallback included, so classified
text still never goes to any model.

### Warm up and status

- **Warm up** sends the job's tiny request to the main provider, so an
  unloaded model starts loading before the session does.
- Each job shows whether its model is **loaded** or **unloaded**, read from
  Argos's `GET /v1/models` (other servers show "status unknown"), or that the
  model is not found or the provider is unreachable. **Refresh status**
  asks again.
- Keeping a model loaded during a session is the job's **During a game
  session** choice, handled by Game night below.

### Local or cloud, per job

Every job row has a **Local** / **Cloud** choice and a chip saying which it
is. Picking one filters the provider list to providers of that location
(set on the provider: **Where it runs**). The last provider and model you
saved in each place is remembered per job, so switching back is one click;
a choice you have not saved yet is kept while you flip between the two. A
fallback shows its own location, and the rule is unchanged: a local job with
a cloud fallback only falls back to the cloud when **Allow falling back to
the cloud** is ticked.

### Game night: loading and unloading around a session

Admin → Models → **Game night** is one setting for the whole server (not
per world: the GPUs are shared by every world). A session is live while a
DM records audio, has the session chat open, or has pressed **Start game
night** (rows older than a day are ignored, so a crashed recording cannot
hold models forever).

Each job has a policy: **Keep loaded** (the default for chat, audit, audio
and embeddings) or **Load when needed** (voice and rerank). When a session
starts, every Keep loaded model is loaded at once and held while it runs:
checked every minute and reloaded if the server let it go. After the last
session ends, a grace period (10 minutes by default, so a break or a
restarted recording does not unload anything) then each held model is
unloaded. While no session is open and nothing is held, Alexandria sends
the model servers nothing. A restart mid-session re-warms; a restart after
one unloads what was left held.

What "load", "hold" and "unload" mean depends on the server, found by asking
it once (cached; **Detect again** or pick the type by hand under **Model
servers**):

| Server | Load and hold | Unload |
| --- | --- | --- |
| Argos | a tiny request; Argos keeps the model for its `ttl` (`0` = never unloads), refreshed before a non-zero ttl runs out | `POST /api/models/unload/{model}` |
| llama-swap | a tiny request, repeated just inside the ttl you enter (llama-swap does not report it) | `POST /api/models/unload/{model}` (older builds: `GET /unload`, which unloads everything) |
| Ollama | `keep_alive: -1` | `keep_alive: 0` |
| LM Studio | `POST /api/v1/models/load` when it has it, else a tiny request | `POST /api/v1/models/unload`, else its own idle timer |
| Other OpenAI-compatible (vLLM, llama.cpp, a proxy) | nothing: it cannot be told to keep a model; optional ping every N minutes | nothing |
| Hosted (OpenAI, OpenRouter, any cloud provider) | nothing, never pinged | nothing |

If a server keeps unloading a held model (more than three times in ten
minutes, usually one model at a time on that server), Alexandria stops
reloading it for ten minutes and says so instead of thrashing.

The DM's table page shows a **Models ready** card while a session is live:
`chat ✓ audit ✓ whisper … loading`. **Unload all job models now** unloads
every job model on a server that can, whether or not it was held.

The requests are fixed strings ("Reply with the single word: ready", a
half second of silence, a short test sentence) and body-less management
calls. No world text is sent.

### The VRAM view

Admin → Models → **VRAM** reads each Argos provider's `GET /api/pool` and
`GET /running` and shows:

- the cards: total, used and free GiB (the pool's plan from each model's
  declared `vram`, not live memory);
- the loaded models with their declared VRAM;
- a **budget** for the models the jobs use: the sum of their declared VRAM
  against the free space (plus what they already hold), and a check per job
  model: fits, **no vram declared** (the pool cannot plan for it), **not an
  Argos model name**, **too big** (more than all the cards together) or
  **won't fit with the others** (placed largest first, each model on the
  card with the most room; only a model bigger than one card is split, as
  the pool does).

If the pool router is off, it says so and lists what `/running` reports.

**Copy Argos config** produces YAML to merge into Argos's config so the job
models stay resident. Which one to use depends on Argos's router:

- **Group router** (the default): `ttl: 0` on each model (never unload on
  idle) and a `dnd` group with `persistent: true`, `swap: false`,
  `exclusive: false` and the models as members, so they all stay loaded and
  no other group can evict them.
- **Pool router:** `ttl: 0` and a `vram:` per model, and the models under
  `routing.router.settings.pool.persistent`, so the pool never evicts them
  for another model.

Merge the `ttl` and `vram` lines into your existing model entries; do not
repeat a model key.

### Rerank

If the rerank job is set, library search and the DM agent's library matches
take the top 20 hits, send the query and each hit's title and snippet to
`POST {base}/rerank` with `{ model, query, documents, top_n }`, and order by
the returned `results[{ index, relevance_score }]`. It has a 300 ms budget:
slower, failing or returning nonsense, the keyword order stands. The
snippets come from the same viewer's copy of each page (a player's search
sends only what a player may read), and the classified guard applies.

### Admin API

All admin only (others get 403).

- `GET /api/admin/models` lists `{ jobs, providers }`, never with a key.
- `PUT /api/admin/models` with `{ "jobs": { "chat": { "providerId", "model", "options", "enabled", "gameNight", "fallback": { "providerId", "model", "options", "allowCloud" } } } }`
  (`"fallback": null` removes it). Only the jobs and fields you send change.
  The older `{ "baseUrl", "apiKey" }` shape still works: it finds or makes a
  provider for that URL.
- `POST /api/admin/models/providers`, and `PUT` / `DELETE
  /api/admin/models/providers/:id`. A provider a job uses cannot be deleted.
- `POST /api/admin/models/discover` with `{ "providerId" }` or
  `{ "kind": "argos", "baseUrl", "apiKey" }`: the provider's models, a
  suggested model per job with the reason (or why it is left unset) and
  Argos's voices.
- `GET /api/admin/models/status`: loaded or unloaded per job, from Argos.
- `GET /api/admin/models/lifecycle`: `phase` (`off`, `warming`, `ready`,
  `releasing`), `live` and `reasons`, `graceUntil`, `holds` (per held model:
  jobs, backend, state), `policies` per job, `lastRelease` and per provider
  the detected `backend` with what it can do. `PUT` it with
  `{ "graceMinutes", "policies": { "chat": "hold" | "ondemand" } }`.
- `POST /api/admin/models/game-night/start` and `/game-night/end`
  (`{ "now": true }` skips the grace period).
- `POST /api/admin/models/providers/:id/detect` probes the server type
  again; `PUT /api/admin/models/providers/:id` with `{ "backend", "ttl",
  "pingMinutes" }` overrides it.
- `POST /api/admin/models/unload-all` (returns `results` per model).
- `GET /api/admin/models/vram`: per Argos provider, `pool`, `running`,
  `budget`, `jobModels` and the `config` snippets for both routers.
- `GET /api/worlds/:world/models/ready` (DM only): the warm state for the
  table page card.
- Each job in `GET /api/admin/models` has `location` and `lastChoice`
  (`{ local, cloud }`, each `{ providerId, model }` or `null`).
- `GET /api/admin/models/providers/:id/voices?model=`: preset voices.
- `POST /api/admin/models/:job/test` (`?which=fallback`) and
  `POST /api/admin/models/:job/warm` return `{ ok, job, ms, sample }` or
  `{ ok: false, error }`.

The voice feature can ask for preset voice names with
`listVoiceNames(deps)` from `features/models/index.ts`: Argos's
`/v1/audio/voices` for the voice job's model, or `[]` for any other server.

## Argos (one link for everything)

Argos is a model gateway that serves every job from one address and routes
each request by model name:

| Job | Argos endpoint |
|---|---|
| chat, audit | `/v1/chat/completions` |
| extra | `/v1/embeddings` |
| audio (speech to text, e.g. whisper) | `/v1/audio/transcriptions` |
| voice (text to speech, e.g. Kokoro) | `/v1/audio/speech`, voices at `/v1/audio/voices` |
| rerank | `/v1/rerank` |

In **Admin → Models**, use the **Argos** card at the top:

1. Paste the address, with or without `/v1` (`http://argos:8080`), and the
   API key if Argos has `apiKeys` set (it is sent as a Bearer token; Argos is
   open when none are set).
2. Press **Discover**. Alexandria reads `GET /v1/models`, which tells it each
   model's `status` (loaded or unloaded), input and output modalities,
   capabilities (tools, vision, reranker) and context length, and shows them
   in a table. It suggests a model per job:

   | Job | Picked when |
   |---|---|
   | voice | the model's output is audio |
   | audio | audio in and text out (and it does not call tools, or is named like whisper) |
   | rerank | the reranker capability, or "rerank" in its name |
   | chat | text in and out **with tools**; several: the loaded one with the largest context |
   | audit | named like an auditor or classifier, else the smallest text model (by the size in its name, then context) that is not the chat model |
   | extra | "embed" in its name or description |

   When the metadata does not make the answer clear (no model says it can
   call tools, two text models and nothing to tell their size apart, no
   reranker listed), the job is left unset and the page says why. You choose
   it yourself.
3. **Save provider**. The suggestions are assigned to the jobs that have no
   provider yet.

The provider card links to the Argos web page (the address without `/v1`),
and **Discover models** on it asks again after you change Argos's config. The
job page shows each model as loaded or unloaded, and **Warm up** loads it
before the session starts.

To set it from the environment instead, see
`deploy/examples/argos.override.yml`.

## Mixing local and cloud

Providers are independent, so a job can use any of them. Typical mixes:

- **Everything on Argos.** One provider, six jobs.
- **Local audio, frontier chat.** Whisper and Kokoro on Argos (the table's
  audio never leaves home), chat on OpenAI or another frontier provider
  (`cloud`). Chat sends the DM's questions and the library text it needs to a
  third party, so check what that provider keeps.
- **Local with a cloud safety net.** Chat on Argos, fallback to a cloud
  model. Tick **Allow falling back to the cloud** only if you are happy for
  world text to go there when your local model is down. Without the switch
  the job simply stops answering until Argos is back.
- **Two local boxes.** Fallback from one local provider to another needs no
  switch.

Whatever the mix, classified text is never sent to any model, cloud or
local, main or fallback: `core/ai.ts` refuses the request before it leaves.

## The players' quick helper (a small second model)

The **Quick help** card sits above the table helper on a player's Ask page:
**My turn**, **Sum up my sheet**, **What next?**, **Story so far** and a box
for a quick rules question. It runs the **helper** job, meant for a small model on its own
llama.cpp server next to the main chat model.

How it works (`librarian/src/features/playerhelp/quick.ts`):

- **No conversation.** Every tap starts fresh: one system prompt and one short
  brief, rebuilt from what this player may see. That is their character, HP
  and conditions (the player sheet, or their own line in the combat tracker),
  their items, the combat as they see it, tonight's party summary and the
  last six lines the table heard, their goals and journal, two rules passages
  from the world's module and three library chunks shared with the party.
  DM-only text never goes in, and every section passes the classified guard
  first. The brief is about 1,000 to 2,000 characters, so a 4K context per
  slot is plenty and the slots are reused call after call.
- **What they can do.** For My turn, What next? and a sheet summary the brief
  also lists the character's class and level, ability scores with modifiers,
  mana, weapons they carry (with damage and properties from the module's
  item cards), class features up to their level, known spells, and sheet
  modules about abilities, attacks or spells. My turn answers only from that
  list.
- **Story so far** (`recap`) sums up the last four published session logs,
  the chronicle arcs players can see, the player's goals and journal, goals
  the DM gave them and broker answers they bought. Nothing unpublished or
  DM-only goes in, and the model is told to say "not known yet" instead of
  filling a gap.
- **Narrow jobs.** `rules`, `turn`, `sheet`, `suggest`, `recap` and short
  `ask` questions. It changes nothing and has no tools.
- **Hand-offs.** Who, why, history and rumour questions go to the **broker**
  without asking the small model, because small models invent names there.
  Writing, changes ("add a potion to my pack") and questions over 400
  characters go to the **table helper**, the player assistant on the main
  model with tools. The model can also hand off by replying
  `HANDOFF broker:` or `HANDOFF helper:`. If it is down or slow, the question
  goes to the table helper. A hand-off puts the question in that chat's box
  for the player to send.
- **The broker, in the background.** When a question goes to the broker, or
  the answer says the character does not know, the card offers **Ask the
  broker** right there: it gets the usual quote, the player pays (or not),
  and the answer arrives on the Broker page. **Talk to the broker instead**
  opens the broker chat with the question in its box.
- **Made-up names are dropped.** A line that names two or more capitalised
  words the brief never mentions (a "Silas Blackwood" behind the council) is
  removed. If nothing is left, the question goes to the broker.
- One question at a time per player. A second tap while one is running gets
  a 429.

Real-model tests (`web/e2e/quickhelp.mjs` with `QUICK_HELPER_URL`, and
`web/e2e/tablenight.mjs`) use Bonsai 2 9B on OpenRouter
(`prism-ml/ternary-bonsai-2-9b`) for this job; the agentic jobs there use
`tencent/hy4-flash`.

Turn it off for a world with the setting `quickHelper: false`. The DM can see
exactly what a player's helper is given at
`GET /api/worlds/:w/helper/quick/brief?task=sheet&account=<player id>`.

### Setting it up

Admin → Models → **Quick helper (small model)**: a provider pointing at the
small server, and its model name. Or use the environment:
`ALX_MODEL_HELPER_URL`, `ALX_MODEL_HELPER_MODEL`, `ALX_MODEL_HELPER_KEY`,
`ALX_MODEL_HELPER_OPTIONS`. Extra options that fit a small non-thinking model:

```json
{ "contextTokens": 4096, "reasoningModel": false, "maxConcurrent": 4 }
```

`contextTokens` sizes the brief (4096 gives about 10,000 characters of room,
far more than it uses). `reasoningModel: false` sends the 400-token answer
limit as it is, instead of the 2,000-token floor that thinking models need.
`maxConcurrent` should match the server's `-np`.

A llama-server for it, on the gfx906 ROCm fork (`Wizard815/mx-llama.cpp-Rocm10`):

```bash
llama-server -m Ternary-Bonsai-2-9B-Q2_0.gguf --port 8081 \
  -ngl 99 -fa on -c 16384 -np 4 --jinja --reasoning off \
  --temp 0.7 --top-p 0.8 --top-k 20 --min-p 0 --presence-penalty 1.5
```

`-c 16384 -np 4` gives four players a 4K slot each. `--reasoning off` stops
Qwen-family models from thinking (the quick helper wants short answers). The
sampling values are Bonsai's own non-thinking settings. For another model,
use what its card recommends.

### Which model

Anything about 4B or less, or a ternary model, with a file of 6 GB at most:

| Model | File | Notes |
|---|---|---|
| `prism-ml/Ternary-Bonsai-2-9B-gguf`, the **Q2_0** file | 2.56 GB | 9B Qwen3.5 with ternary weights. The best answers in our runs. On the fork use the `Q2_0` file: `PQ2_0` and `PTQ1_0` need PrismML's own llama.cpp, and the fork rejects them as unknown types. |
| Ministral 3B | about 2–3 GB at Q4–Q6 | Fast and well-formatted. Pads turn options with things the character may not have. |
| Llama 3.2 3B Instruct | about 2–3 GB at Q4–Q6 | Good rules answers. |
| Qwen3 4B / 1.7B | about 1–3 GB | Run with `--reasoning off`. |
| Gemma 3 4B | about 3 GB at Q4 | Weakest in our runs: stray words at the start of answers, one empty reply. |

**Ternary GGUFs on the gfx906 fork.** The fork has the `Q2_0` type with HIP
kernels (dequantize, mat-vec and the MMQ tiles for GCN), and the
`prism.hadamard` runtime that the Bonsai weights need (the rotation folded
into them is undone on the activations by a plain matmul). Without that
runtime the output is silent garbage. We loaded
`Ternary-Bonsai-2-9B-Q2_0.gguf` on a CPU build of the fork and got coherent
answers. It was not run on a gfx906 card. The MTP and DFlash drafter files
are for PrismML's fork. Bonsai is a hybrid model (3 linear-attention layers
to 1 full-attention), so llama.cpp cannot roll part of a prompt back; the log
says `refusing rollback`. That is harmless here, because every quick-helper
call is a fresh prompt anyway.

Real-model run (Nov 2026; 8 player questions against a small world with a
fight on; OpenRouter, about $0.0003 per model): Bonsai 2 9B, Ministral 3B
and Llama 3.2 3B gave correct Dodge and Hide rules from the module passages,
sensible turn options and a correct sheet summary. Before the who/why rule,
Gemma 3 4B answered "who secretly controls the council" with a merchant it
made up; now that question goes to the broker before any model sees it.
Qwen3 was not in this run. Every model sometimes
invented details in "What next?" (a chest, a goal to escape a warehouse).
Treat it as ideas for the player, not facts.

## Recommended local models (64 GB of VRAM)

Pick current versions when you build; these are size classes, not pins.

| Job | Size class | Examples | About |
|---|---|---|---|
| chat | 27–32B, 4–6 bit | Qwen3 32B, Gemma 3 27B, or a 30B mixture-of-experts model for speed | 20–26 GB plus context |
| audit | 3–4B | Qwen3 4B, Gemma 3 4B | 3–5 GB |
| audio | Whisper large-v3 class | faster-whisper or whisper.cpp with large-v3-turbo | 3–6 GB |
| voice | Small | Kokoro-82M | under 1 GB |
| extra | Small | bge-m3 or similar | 1–2 GB |
| helper (optional) | ≤4B, or ternary 9B | Ternary Bonsai 2 9B (Q2_0), Ministral 3B, Llama 3.2 3B | 2–6 GB |

That is about 30–40 GB loaded together. The rest is for the chat model's
context (long transcripts need it) and a larger model later.

### Running everything locally on 64 GB

A plan for one box with 64 GB of VRAM (for example two 32 GB cards). The
sizes are estimates: check your own model files, quant and context, and set
Argos's `vram` from what you measure.

| Job | Suggested | Approx. VRAM |
|---|---|---|
| Chat | A ~30B mixture-of-experts model (about 3B active) at Q4_K_M, 32k context, 4 parallel slots | 22–26 GB |
| Audit (decision) | A 3–4B instruct model at Q8, 8k context | ~5 GB |
| Speech to text | Whisper large-v3-turbo (faster-whisper int8), one instance handling 5 live mics at 5 s chunks | 3–4 GB |
| Text to speech | Kokoro-82M | under 1 GB |
| Embeddings | bge-m3 class | ~1.5 GB |
| Rerank | bge-reranker-v2-m3 class | ~1.5 GB |
| Total | | about 34–39 GB, leaving ~25 GB free |

Why these choices:

- **MoE over dense for chat.** A dense 32B model reads all 32B weights for
  every token, so it is about 3× slower per token than a mixture-of-experts
  model that activates about 3B of its 30B, and it needs more KV cache (the
  attention memory that grows with context and parallel slots). The MoE
  still holds all its weights in VRAM, which is why it is 22–26 GB and not 3.
- **The 2 GB reserve.** Argos's pool keeps `reserveGiB` (default 2 GiB per
  card) free for KV cache growth, compute buffers and other processes, so a
  32 GB card plans with about 30. Do not plan to fill a card.
- **On 2 × 32 GB,** put chat on one card and everything else on the other.
  The chat model gets a whole card's compute and bandwidth, and the small
  models (about 12 GB together) never compete with it. The pool router does
  this by itself when the sizes are declared; with the group router, pin each
  model's card with `HIP_VISIBLE_DEVICES` or `CUDA_VISIBLE_DEVICES` in its
  `env`.
- **The ~25 GB left over** can go to a longer context (chat memory grows with
  it), a bigger quant of the chat model (Q6 instead of Q4_K_M), or a vision
  model for maps and handouts.
- **What a reranker is.** Search first finds candidates cheaply (keywords,
  embeddings). A reranker is a relevance scorer: it reads the question and
  each candidate together and scores how well the candidate answers it, then
  the list is reordered by score. Cloudflare's bge-reranker, Jina Reranker
  and Cohere Rerank are hosted ones; bge-reranker-v2-m3 is a common local
  one. It is optional: without it search keeps its keyword order.
- **Why audit is a small chat model, not a reranker.** The audit job decides
  things in words: whether a question is about a secret, where a question
  should be routed, whether an answer spoils the plot. That needs a model
  that can follow an instruction and answer in JSON, which a reranker (it
  only returns a score per document) cannot do. Keep it small so the check
  is fast.

Leave those jobs on **Keep loaded** (Game night above), press **Copy Argos
config**, and Argos keeps all of this resident for the whole session.

## Pointing each job at a server

- **Argos or llama-server** (chat, audit, extra). Base URL
  `http://<host>:8080/v1`. llama-server serves one model per process, so
  run a second one on another port for audit and a third with `--embedding`
  for extra. The model name is usually ignored; put something readable.
  Example override: `deploy/examples/argos.override.yml`.
- **A whisper server** (audio). faster-whisper-server, whisper.cpp's server
  or similar, on `http://<host>:8000/v1`. The model name is the model it
  loads (e.g. `Systran/faster-whisper-large-v3`). Alexandria asks for
  `verbose_json` with word timestamps. Example:
  `deploy/examples/whisper.override.yml`.
- **Kokoro** (voice). A Kokoro server exposing `/v1/audio/speech`, e.g.
  `http://<host>:8880/v1`, model `kokoro`, options `{"voice":"af_heart"}`.
  Example: `deploy/examples/kokoro.override.yml`.
- **Ollama.** `http://<host>:11434/v1` for chat, audit and extra, model
  names as in `ollama list`. Ollama has no speech endpoints. Example:
  `deploy/examples/ollama.override.yml`.
- **A cloud endpoint.** Its `/v1` URL, the model name and the API key.
  Remember that anything sent to chat leaves your server. Players' questions
  never include DM-only text, but check what a provider keeps before you
  point the DM agent at one.

Inside Docker, use the service name (`http://whisper:8000/v1`) when the
server is in the same Compose project, and `host.docker.internal` (see
`argos.override.yml`) for the machine running Docker.

## OpenAI and compatible servers

Every chat call goes through `librarian/src/core/ai.ts`, which speaks the
OpenAI Chat Completions API and adapts to the server behind the URL. It
streams replies, sends `tools` with `tool_choice` and `parallel_tool_calls`,
asks for JSON with `response_format`, and gives clear errors: a wrong key
(401), a wrong model name (404), a rate limit (429, retried twice after
`Retry-After`) and a server that does not answer (a timeout).

### Job options

Put these in the job's **Extra options** (Admin → Models). Alexandria reads
them itself and does not send them to the server. Any other key in Extra
options is sent as is (`top_k`, `chat_template_kwargs`, ...).

| Option | Values | What it does |
|---|---|---|
| `maxTokensParam` | `"auto"` (default), `"max_tokens"`, `"max_completion_tokens"` | Which field carries the reply length limit. `auto` sends `max_completion_tokens` to `api.openai.com` (newer OpenAI models reject `max_tokens`) and `max_tokens` everywhere else. If a server answers 400 about it, the other name is tried and remembered. |
| `noTemperature` | `true` / `false` (default) | Leave `temperature` out. Set it for OpenAI reasoning models (o-series, GPT-5 family), which only accept the default. A 400 that mentions `temperature` turns it on by itself. |
| `jsonMode` | `"auto"` (default), `"schema"`, `"object"`, `"off"` | How a job that needs JSON asks for it. `auto` tries `json_schema` when a schema is given, then `json_object`, then falls back to a plain instruction in the prompt, moving down whenever the server answers 400 (llama-server, Ollama, LM Studio and vLLM differ here). The mode that works is remembered per job and model until the server restarts. `object` and `off` cap how far it tries. |
| `timeoutMs` | milliseconds; default `120000` for chat and audit, `300000` for the rest | Give up when the server has not answered, or (for a streamed reply) has sent nothing, for this long. A slow local model on a long prompt may need more. |
| `minOutputTokens` | a number; default `2000` for chat and audit | The least `max_tokens` a chat or audit request asks for. A reasoning model spends part of the limit thinking, so a small limit can come back empty; the floor stops that. If an answer still comes back empty because the limit cut it off, Alexandria asks once more with twice the limit (and, on OpenRouter, with `reasoning: {enabled: false}`). |
| `reasoningModel` | `false` to switch the floor off | Set `false` for a model that does not think, to send the small limits as they are. |

Example, for an OpenAI reasoning model:

```json
{ "noTemperature": true, "timeoutMs": 180000 }
```

### Recommended settings

| Server | Base URL | Extra options | Notes |
|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | Nothing for a chat model such as `gpt-4o-mini` or `gpt-4.1-mini`. For a reasoning model: `{"noTemperature": true}`. | Put the key in the API key field. Anything sent to chat leaves your server. `max_completion_tokens` is used automatically. Use a small model for **audit**. |
| **Argos** | `http://<host>:8080` | Nothing. Use the Argos card: Discover assigns every job. | One address for chat, audit, speech, voice, embeddings and rerank. |
| **llama-server** | `http://<host>:8080/v1` | Usually nothing. Start it with `--jinja` so tool calls work. | Streams, tool calls and `json_object` work. Older builds ignore `json_schema` or answer 400, and Alexandria falls back by itself. The model name is ignored. Keep the prompt cache on (the default): the system prompt is the same for every message, so only the new part is processed. |
| **Ollama** | `http://<host>:11434/v1` | `{"jsonMode": "object"}` if you see structured-output errors. | Model names as in `ollama list`. Use a model that supports tools. Raise the context (`num_ctx`) for long transcripts, and set `OLLAMA_KEEP_ALIVE` so the model stays loaded between messages. |
| **LM Studio** | `http://<host>:1234/v1` | `{"jsonMode": "object"}` | Load the model first. Its `json_schema` support depends on the model, which the fallback covers. |
| **vLLM** | `http://<host>:8000/v1` | Start it with `--enable-auto-tool-choice` and a `--tool-call-parser` for your model. | `json_schema` works and `parallel_tool_calls` is accepted. |

### Reading the timings

Each assistant reply carries `timings` (shown under the message in the DM's
assistant, and written to the audit log as `agent.timing`), in milliseconds:

- `totalMs`: from the message arriving to the reply being finished.
- `firstTokenMs`: until the first text reached the screen. Almost all of it
  is the model's own time to first token, prompt processing included.
- `modelMs`: time inside model calls. `rounds` is how many calls there were;
  a question answered from the library matches that come with it takes one.
- `toolMs`: wall time running tools. Several tool calls in one turn run
  together, so this is the slowest one, not the sum.
- `prepMs`: the library search and context gathering before the first model
  call (part of `gatewayMs`).
- `gatewayMs`: `totalMs - modelMs - toolMs`, Alexandria's own overhead. It
  should stay under about 50 ms per round. If it does not, look at the
  size of the world: the player leak check reads every page once per reply
  (`gateMs` is the time it spent checking sentences).
- `toolsOffered`, `snippets`: how many tools and library matches went to the
  model. `fast: true` means a rule answered (dice, the date, next turn, add
  creatures) and no model was called.

Reading it: a high `firstTokenMs` with a low `gatewayMs` is the model or its
server (a bigger prompt, a cold model, a slow disk): try a smaller or
quantized model, keep it loaded, and check that prompt caching is on. A high
`toolMs` is a slow tool. A high `rounds` means the model keeps calling tools
because the matches did not answer it.

## The fake models server

For demos and tests there is a deterministic OpenAI-compatible server with
no dependencies beyond `node:http`:

```bash
node --experimental-strip-types librarian/scripts/fake-models.ts --port 8300
```

Then add `http://127.0.0.1:8300` as one **Argos** provider in Admin → Models
and press Discover (that is what `librarian/scripts/demo.ts` does), or set
`ALX_MODEL_CHAT_URL=http://127.0.0.1:8300/v1` and so on. It never calls a
real model.

| Endpoint | What it does |
|---|---|
| `GET /v1/models` | Argos-shaped records for `fake-chat` (tools, 32768 context), `fake-audit`, `fake-whisper`, `fake-kokoro`, `fake-embed` and `fake-rerank`: `status`, `architecture` modalities, `capabilities` and `context_length`. `startFakeModels(0, host, { unloaded: ['fake-rerank'], apiKey: 'sk-x' })` reports models as unloaded and requires a Bearer key |
| `GET /api/pool` | The pool router's shape: `cards` (`cap_gib`, `used_gib`, `free_gib`, `models`) and `models` (`state` ready or stopped, `size_gib`, `size_known`, `cards`, `persistent`), with declared sizes for a 64 GB box (chat 24, audit 5, whisper 3.5, kokoro 0.9, embed 1.5, rerank 1.5). `startFakeModels(0, host, { router: 'group' })` answers `{ "router": "group", "enabled": false }` like an Argos without the pool; `vram: { 'fake-audit': null }` leaves a model undeclared |
| `GET /running` | `{ "running": [{ model, state, cmd, proxy, ttl, name, description }] }` for the loaded models |
| `POST /api/models/unload/{model}` | `OK` (404 `model not found` for an unknown name). The model reads unloaded until a request to it loads it again; `fake.loaded()` lists what is loaded |
| `GET /v1/audio/voices` | `{ "voices": ["af_heart", "af_bella", "bm_george", "bf_emma"] }` |
| `POST /v1/rerank` | `{ model, query, documents, top_n }` in, `results[{ index, relevance_score }]` out, scored by words shared with the query |
| `POST /v1/chat/completions` | If `tools` are given and the last message is the user's and contains a tool's name (e.g. `list_pages`), returns a `tool_calls` entry for it with `{}` arguments. With `response_format: json_object`, returns the JSON from a `FAKE_JSON: {...}` line in the system prompt, or `{}`. Otherwise echoes `You said: "<first 80 chars of the last user message>"` and, if a `Context:` block is in the prompt, its first sentence (or, for the agent, the first library match it was given). `stream: true` sends OpenAI-shaped chunks: content a few words at a time, tool calls as an id and name then the arguments in pieces, and a usage chunk with `stream_options.include_usage`. Set `FAKE_TOKEN_DELAY_MS` to slow the chunks down for a demo. |
| `POST /v1/audio/transcriptions` | `verbose_json` with segments and word timings. If the uploaded file's bytes start with `FAKE:`, the rest is the transcript, spaced 0.4 s per word, one segment per sentence. Any word may end in `\|p=0.4` to set its probability (the default is 0.95). Any other file gives `(inaudible)`. |
| `POST /v1/audio/speech` | A valid 0.3 s, 440 Hz WAV |
| `POST /v1/embeddings` | A 64-float unit vector from a hash of the text, the same every time |

In a test:

```ts
import { startFakeModels } from '../scripts/fake-models.ts';
const fake = await startFakeModels(0);      // 0 = any free port
fake.baseUrl;                                // http://127.0.0.1:<port>/v1
fake.requests;                               // every request seen: method, path, authorization, body
await fake.close();
```

To feed it speech, upload bytes such as `new TextEncoder().encode('FAKE: the orc attacks.')`
to `transcribe()` from `core/ai.ts`.


## Audio: transcription tuning

- **Hint.** Each chunk is sent a prompt of at most 150 characters: player and character names, proper nouns from pages players can read (ranked by recency and how often the table said them), and dice words (`d4 d6 d8 d10 d12 d20 nat 20 advantage disadvantage`). DM-only, broker and classified titles never go in it, and a quiet chunk gets none. World setting `transcriptHint: on|off` (default on). `transcriptContext: on|off` (default off) also sends the mic's previous words.
- **Dropped:** segments with compression ratio above 2.4, log probability below -1.0, no-speech probability above 0.6 (unless the words are confident), known junk phrases, repeats of the prompt, and word loops. The DM sees counters in `GET /audio/status` (`dropped`). A chunk with any of these made-up segments is asked again without the hint (names the speech does not contain can pull a small model off course), and the answer with more confident words is kept; on a 10-minute real recording with base.en this cut empty chunks from several to 2 of 121 and brought word error down to that of no hint at all, for about 30% more calls on that noisy table. A chunk that still loops is asked once more with `temperature` 0.4; otherwise temperature is left to the server.
- **Chunks.** The browser sends a chunk every 5 s that also carries the 3 s before it; the server keeps each stretch from the chunk it is most central in.
- **Lines.** At most 20 s long and updated in place. A DM-only title that shows up in a line heard by one mic only makes the line DM-only. A personal mic is credited only when clearly louder than the others; otherwise the speaker is "Table".
- **Refine pass (off).** World setting `transcriptRefine: on` plus the audio job option `refineModel` (env `ALX_MODEL_AUDIO_OPTIONS='{"refineModel":"large-v3"}'`) re-transcribes kept audio in 60 s windows after a recording stops (needs `ffmpeg` on the server). Lines keep ids; DM-only lines stay DM-only. Job options `temperatureFallback: true` lets a list of temperatures be sent.

## What helps the DM agent (real-model ablations)

Measured with deepseek-v4.1-flash through OpenRouter on a made-up demo world
(83 fresh natural requests, 32 world-knowledge questions, 57 broker questions).
Samples are small (28 requests per variant; one request is 3.6 points), so only
large effects are trustworthy. The embedding-only checks over all 83 requests
are free and more reliable.

| Tool offer | Wanted tool offered (83) | Strict pass (28) | Tools offered |
|---|---|---|---|
| keywords (old default) | 73/83 | 22/28 | 16 |
| all 123 tools | 83/83 | 25/28 | 120 (2x cost) |
| embeddings only (k=10) | 63/83 | 25/28 | 19 |
| keywords + embeddings | 78/83 | 23/28 | 23 |
| concise descriptions, keywords | n/a | 25/28 | 16 |
| concise + keywords + embeddings | 82/83 | 24/28 | 22 |

Concise "use when ... example" descriptions are what make embedding selection
work. With the lighter system prompt on top (a different 28 requests, where the
old default scored 24/28) the result was 26/28, 2.6 model rounds instead of 3.3
and one unrequested write instead of four.

- **Embedding model matters.** `cohere/embed-5-fast` put the right page first
  for only 13 of 29 questions; `baai/bge-m3` (about $0.01 per million tokens) 26,
  `google/gemini-embedding-001` 26, `openai/text-embedding-3-small` 25. Use a
  retrieval model such as bge-m3 for the `extra` job. (cohere was better at the
  broker's short-question examples.)
- **Hybrid retrieval** has to weight the embeddings above the keyword list (loose
  word matches): equal-weight fusion with cohere lowered the right page in the
  top 3 from 23/29 to 19/29. The agent uses the five nearest pages at weight 1.5
  plus the keyword hits; a title named in the question stays on top. The rule
  was chosen offline on the same 29 questions; no end-to-end run with bge-m3.
- **System prompt rules** (look up the codex first, always add to it) made 39%
  of requests call who_is or context_for needlessly and 13% make an unrequested
  write. The `lite` prompt keeps the grounding rules and says to call the
  matching tool right away.
- **Campaign Status prefetch** and **story_bible**: no measurable difference
  (24/28 without the status vs 22/28 with; the bible tool was called in 2 of
  83). Both stay switchable.
- **Broker examples** (nearest-example caution, few-shot): decisions identical
  (53/57 exact in every variant, 0 unsafe); label agreement 52 to 54 of 57. Off
  by default (`ALX_BROKER_EXAMPLES=nn|fewshot|both`).
- Not measured: rerank end to end, Active mode with examples, the adopted
  configuration on the old 112 requests (budget and time).

Switches: `ALX_AGENT_OPTS='{"tools":"keywords","desc":"current","skills":"full","retrieval":"keyword","status":true,"bible":true}'`.
The defaults are hybrid tools, concise descriptions, the lite prompt and hybrid
retrieval; without an embeddings model the embedding parts act as keywords.
`ALX_BIBLE=off` stops the background story bible build (one chat call per page).

## Active mode: hy4-flash and deepseek-v4.1-flash compared (Nov 2026)

Four scripted sessions (95 expected actions), scored by time window, bge-m3 embeddings, after the
item, fight and skill fixes:

| Model | Actions caught | Automatic actions right | Suggestions right | Median / p90 latency | Cost per call |
|---|---|---|---|---|---|
| tencent/hy4-flash, reasoning off | 82% | 90% | 93% | 1.8 s / 3.4 s | $0.00004 |
| tencent/hy4-flash, reasoning on | 80% | 89% | 81% | 4.9 s / 13.9 s | $0.00018 |
| deepseek/deepseek-v4.1-flash | 85% | 89% | 85% | 2.9 s / 8.9 s | $0.00050 |

hy4-flash thinks before every answer unless told not to. The `audit` job now sends OpenRouter
`reasoning: {enabled: false}` by default; the job option `reasoning: "on"` lets it think, and
`reasoning: "off"` turns it off for the chat job too (and sends the field to a non-OpenRouter
server; a server that refuses it is remembered). The few-shot line examples
(`ALX_ACTIVE_EXAMPLES=1`) did not help either model and stay off.

Replaying three real hour-long sessions (one table recorder, crosstalk, rules chatter) showed no
leaks; the misses were a fight already under way when the recording began (now offered as
"start the combat tracker?") and item suggestions from table talk ("Plus Four", "Resistance"),
which are now filtered by name.

## Minerva request sets on hy4-flash (Nov 2026)

The 112-request tool set and the 83-request fresh set, with `tencent/hy4-flash` for chat and audit
(job option `reasoning: "off"`), bge-m3 embeddings and the default agent options:

| Run | Requested job done, by the scorer | Judged by reading each reply | Median reply | Cost per request |
|---|---|---|---|---|
| hy4-flash, before the fixes below | 177/194 (91.2%) | 189/193 (97.9%) | 6.3 s | $0.00018 |
| deepseek-v4.1-flash, same code | 177/194 (91.2%) | 190/194 (97.9%) | 3.7 s | $0.00089 |
| hy4-flash, after the fixes | 182/194 (93.8%) | 191/194 (98.5%) | 6.3 s | $0.0002 |

The scorer counts a request as missed when the expected tool was not called; reading the replies,
most of those were right (the date answered from the context block, "no macros saved", a vote that
could not be cancelled before approval, a question about which of three drafts). The fixes: the
lite prompt now says to go on to the write after a look-up instead of asking "shall I?" (hy4-flash
stopped there), "display ... for the players" offers show_on_stage, and "something spooky for the
cellar" offers the music tools. Left: "next Friday" for a game night (asks for the real date),
writing and then linking an item page in one turn, and a date change on a draft.

