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
| `POST /v1/chat/completions` | If `tools` are given and the last message is the user's and contains a tool's name (e.g. `list_pages`), returns a `tool_calls` entry for it with `{}` arguments. With `response_format: json_object`, returns the JSON from a `FAKE_JSON: {...}` line in the system prompt, or `{}`. Otherwise echoes `You said: "<first 80 chars of the last user message>"` and, if a `Context:` block is in the prompt, its first sentence. `stream: true` is supported. |
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
