# Models

Alexandria uses five model jobs. Each one points at any OpenAI-compatible
server: Argos (llama-server), a whisper server, Kokoro, Ollama, LM Studio, or
a cloud provider. Set them in **Admin → Models**. Features only reach models
through `librarian/src/core/ai.ts`, so swapping a model never touches a
feature.

## The five jobs

| Job | Used for | Endpoint on the server |
|---|---|---|
| **chat** | DM agent, player Ask, broker answers, session summaries. Also the `/v1/models` and `/v1/chat/completions` passthrough. | `POST {base}/chat/completions` |
| **audit** | The small model: question routing, spoiler checks, second opinions | `POST {base}/chat/completions` |
| **audio** | Speech to text | `POST {base}/audio/transcriptions` |
| **voice** | Text to speech (Speak menu, narration) | `POST {base}/audio/speech` |
| **extra** | Embeddings for library search and broker matching. Also the `/v1/embeddings` passthrough. | `POST {base}/embeddings` |

Each job has:

- **Base URL**, ending in `/v1` (or wherever the OpenAI-style paths start).
- **Model name**, sent as `model` in every request.
- **API key**, optional. It is stored on the server and never sent back: the
  page shows `••••`, and saving with `••••` keeps the stored key. Clear the
  box to remove it.
- **Extra options**, a JSON object merged into every request, e.g.
  `{"voice":"af_heart"}` for the voice job.
- **On/off.** Off, or an empty URL, means "use the server's environment".

A job with nothing saved falls back to the environment:
`ALX_MODEL_<JOB>_URL`, `ALX_MODEL_<JOB>_MODEL`, `ALX_MODEL_<JOB>_KEY`
(`<JOB>` is `CHAT`, `AUDIT`, `AUDIO`, `VOICE`, `EXTRA`), then
`MODEL_BASE_URL` / `LOCAL_LLM_URL` and `MODEL_API_KEY`. With neither, the job
has no model, and features that need it fall back or stay off.

**Test** runs a tiny real call: a one-word chat, a half second of silence for
audio, a short phrase for voice, one sentence for embeddings. It shows ok or
the error, the time it took and a short sample. Save first; Test uses what
is saved.

### Admin API

All admin only (others get 403).

- `GET /api/admin/models` lists the five jobs, never with a key.
- `PUT /api/admin/models` with `{ "jobs": { "chat": { "baseUrl", "model", "apiKey", "options", "enabled" } } }`.
  Only the jobs and fields you send change.
- `POST /api/admin/models/:job/test` returns `{ ok, job, ms, sample }` or
  `{ ok: false, error }`.

## Recommended local models (64 GB of VRAM)

Pick current versions when you build; these are size classes, not pins.

| Job | Size class | Examples | About |
|---|---|---|---|
| chat | 27–32B, 4–6 bit | Qwen3 32B, Gemma 3 27B, or a 30B mixture-of-experts model for speed | 20–26 GB plus context |
| audit | 3–4B | Qwen3 4B, Gemma 3 4B | 3–5 GB |
| audio | Whisper large-v3 class | faster-whisper or whisper.cpp with large-v3-turbo | 3–6 GB |
| voice | Small | Kokoro-82M | under 1 GB |
| extra | Small | bge-m3 or similar | 1–2 GB |

That is about 30–40 GB loaded together. The rest is for the chat model's
context (long transcripts need it) and a larger model later.

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

Example, for an OpenAI reasoning model:

```json
{ "noTemperature": true, "timeoutMs": 180000 }
```

### Recommended settings

| Server | Base URL | Extra options | Notes |
|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | Nothing for a chat model such as `gpt-4o-mini` or `gpt-4.1-mini`. For a reasoning model: `{"noTemperature": true}`. | Put the key in the API key field. Anything sent to chat leaves your server. `max_completion_tokens` is used automatically. Use a small model for **audit**. |
| **Argos / llama-server** | `http://<host>:8080/v1` | Usually nothing. Start it with `--jinja` so tool calls work. | Streams, tool calls and `json_object` work. Older builds ignore `json_schema` or answer 400, and Alexandria falls back by itself. The model name is ignored. Keep the prompt cache on (the default): the system prompt is the same for every message, so only the new part is processed. |
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

Then set every job's Base URL to `http://127.0.0.1:8300/v1` (any key, any
model name) in Admin → Models, or `ALX_MODEL_CHAT_URL=http://127.0.0.1:8300/v1`
and so on. It never calls a real model.

| Endpoint | What it does |
|---|---|
| `GET /v1/models` | Lists five fake model names |
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
