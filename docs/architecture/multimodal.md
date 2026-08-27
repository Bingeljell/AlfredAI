# Multimodal Channels & Voice

**Status:** Draft / planned
**Scope:** Inbound images, voice, audio, video, documents across all channels; outbound voice replies via TTS
**Primary driver:** Telegram (today's dominant user channel); web UI and future channels must share the same shape

---

## Why

All current channels (Telegram, web UI) are text-only. Inbound non-text messages are silently dropped, and there is no path for outbound media. This plan introduces a channel-agnostic attachment pipeline plus bidirectional voice support.

## Goals

- **Channel-agnostic** — any adapter produces and consumes attachments through the same shape.
- **Mirror-modality by default** — voice in ⇒ voice out, with an opt-out *command* (not a setting).
- **Pluggable STT / TTS** — provider selected via environment variable; no provider hardcoded in business logic.
- **Non-breaking** — existing text-only flows keep working unchanged.

---

## Architecture — five pieces

### 1. Blob store (`src/channels/blobStore.ts`)

Content-addressed storage for inbound media.

- Every inbound attachment is written to the blob store and identified by `blobId` (sha256 of bytes).
- All `Attachment` variants reference blobs by id; **no variant ever carries inline bytes**.
- API surface:
  - `put(bytes, mime) → blobId`
  - `get(blobId) → bytes`
  - `getMetadata(blobId) → { mime, size }`

The blob store is the keystone — both the `Attachment` type and the resolver assume it exists.

### 2. Attachment type (`src/channels/types.ts`)

Discriminated union over attachment kind. Variants:

- `image`
- `voice`
- `audio`
- `video`
- `document`
- `url`

Every variant carries `blobId: string` and `mime: string`. Optional metadata:

- `durationSeconds` — audio, voice
- `width`, `height` — image, video
- `filename` — document

### 3. `ChannelMessage` extension

- Add `attachments: ChannelAttachment[]` to the channel message shape.
- `text` becomes optional. Text-only paths are unchanged.

### 4. Resolver (`src/channels/attachmentResolver.ts`)

Sits between `ChatService.handleTurn` and `agentLoop`. Resolves attachments into a form the LLM can consume:

- `image` → inline base64 for vision-capable models
- `voice` / `audio` → transcribed text via the STT provider
- `document` → extracted text
- `video` → extraction strategy TBD (see Open Questions)

Output: a `ResolvedMessage` containing the original `text` plus the resolved content blocks.

### 5. TTS mirror reply

After the agent produces a reply:

- **If** the inbound message carried a `voice` or `audio` attachment **and** a TTS provider is configured, also generate a voice reply.
- The synthesized audio is sent as an outbound attachment alongside (or in place of) the text reply.
- **Always-on when TTS is configured.** Opt-out is a user command (e.g. "type only"), not a persistent setting.

---

## Channel adapter changes

Every adapter gains two responsibilities:

1. **Inbound:** download media from the channel API and write it to the blob store. Telegram uses `getFile`; web UI uses its own upload path.
2. **Outbound:** send attachments via the channel's native API.
   - Telegram: `sendPhoto` / `sendVoice` / `sendDocument`
   - Web UI: render / upload to the browser

The base `ChannelAdapter` interface gains:

- `sendMessage(channelKey, text, attachments)` — extends outbound beyond text
- `downloadMedia(message) → BlobRef` — normalizes inbound media into the blob store

---

## STT providers (pluggable via `STT_PROVIDER`)

| Provider          | Notes                                  |
| ----------------- | -------------------------------------- |
| `whisper-cpp`     | Local, Apple Silicon                   |
| `mlx-whisper`     | Apple Silicon, faster                  |
| `openai-whisper-api` | Fallback                            |

Registry location: `src/channels/stt/{provider}.ts`. Each provider exports:

```ts
{ transcribe(blobId): Promise<{ text: string; language: string; durationSec: number }> }
```

---

## TTS providers (pluggable via `TTS_PROVIDER`)

| Provider          | Notes                                  |
| ----------------- | -------------------------------------- |
| `piper`           | Local, fast, decent quality            |
| `say`             | macOS built-in, lowest quality         |
| `mlx-audio`       | New, good local                        |
| `minimax`         | `minimax/speech-02` via OpenRouter — free, high quality (recommended) |

Registry location: `src/channels/tts/{provider}.ts`. Each provider exports:

```ts
{ synthesize(text, opts): Promise<BlobRef> }
```

**Output format:** OGG Opus (required by Telegram's `sendVoice`). `ffmpeg` converts from the provider's native format as needed.

---

## Environment additions

```dotenv
STT_PROVIDER=whisper-cpp
TTS_PROVIDER=minimax
STT_MODEL_PATH=/path/to/whisper/model.bin   # local providers only
TTS_VOICE_ID=default
BLOB_STORE_PATH=./workspace/alfred/blobs
```

---

## Implementation order

The ordering is deliberate: the first two steps are the keystone that everything else assumes.

1. **Blob store + `Attachment` type** — keystone; nothing else starts without this.
2. **`ChannelMessage` extension + base adapter interface** — wires the new types through the existing channel abstraction.
3. **Telegram inbound handler** — download photos / voice / video / documents into the blob store.
4. **Resolver** — attachments → LLM-consumable content blocks.
5. **STT / TTS provider registry** — provider skeleton + env-driven selection.
6. **Resolver integration** — STT for audio, image passthrough for vision-capable models.
7. **TTS mirror reply in `ChatService`** — voice-in ⇒ voice-out.
8. **Telegram outbound** — `sendPhoto` / `sendVoice` / `sendDocument`.
9. **Web UI attachment support** — inbound upload + outbound rendering.
10. **Opt-out command + "type only" detection** — user escape hatch from mirror-modality.

---

## Failure modes

The architecture is built around two constraints that decide whether any of this is safe to ship:

- **Local-first** — STT/TTS should run on the box whenever the box can take it. Cloud (e.g. `minimax` via OpenRouter) is a free/cheap fallback, not the default.
- **Provider-agnostic** — TTS and STT are features with a registry. Business logic never imports a provider directly; selecting a different provider is an env-var change, not a code change.

Everything below is graded against those constraints.

### 1. Local STT/TTS exhausts the box

A 30-second voice note on `whisper-cpp` small is fine; a 10-minute voice note on `mlx-whisper` large-v3 is not. Long-form audio, a large STT model, and a Mac under thermal throttling can spike RSS to the point where the OS or Alfred's own watchdog kills the process.

**Guardrails:**
- Per-turn STT wall-clock budget (e.g. 30s); reject transcripts that exceed it with a "this voice note is too long, send text or a shorter clip" message rather than letting the process wedge.
- Default STT model in `.env.example` is `whisper-cpp` with a *small* model variant, not large.
- The provider registry exposes `capabilities.modelSize`; the resolver picks a model sized to the audio duration, falling back to chunked transcription rather than loading a larger model.

### 2. Cloud provider is down, rate-limited, or stops being free

`minimax/speech-02` is free through OpenRouter *today*. Free-tier rate limits, a pricing change, or an upstream outage would break every voice reply without warning.

**Guardrails:**
- The TTS provider registry already supports `piper` and `mlx-audio` as local providers. Recovery from a cloud outage is an env-var change (`TTS_PROVIDER=piper`), not a deploy.
- The TTS step surfaces provider errors as a user-visible message ("voice reply unavailable, sending text only") and *still sends the text reply*. The mirror must never block the text path.
- Same pattern for STT: if the configured provider errors, fall back to a local one, and if that also fails, surface the failure rather than silently dropping the voice note.

### 3. `ffmpeg` is not on `PATH`

Telegram's `sendVoice` requires OGG Opus. The doc assumes ffmpeg is installed; if it isn't, the TTS pipeline produces a file Telegram won't play (or throws at the conversion step).

**Guardrails:**
- A startup check verifies `ffmpeg -version` and refuses to enable TTS mirror mode (with a clear log line) if it's missing. TTS stays opt-in via env, so a missing ffmpeg degrades cleanly to text-only.
- STT does *not* need ffmpeg, so missing ffmpeg should not block voice transcription.

---

### 4. Image sent to a non-vision model

The active LLM doesn't accept image input. Today this isn't enforced anywhere — the resolver would either inline a base64 image the provider rejects (4xx, opaque error) or silently drop it.

**Guardrail (hard requirement):** the resolver inspects the active model's declared capabilities before resolving any image attachment. If the model is not vision-capable, the user gets an explicit message at the start of the reply — e.g.:

> "I got your image but the active model (`openai/gpt-4o-mini`) doesn't support image input. Switch to a vision model (`/model openai/gpt-4o`) or describe what's in the image and I'll work from the description."

The text reply then proceeds with whatever the user typed. The image is never silently dropped and never sent to a model that can't consume it. The same check applies to inbound URLs that resolve to images: capability check, then either inline base64 (vision model) or a "I can fetch this but not see it" message.

### 5. Audio transcription blows the context window

STT can return tens of thousands of tokens for a long voice note. Naively pasting that into the conversation context can crowd out the system prompt and recent history, or exceed the model's input cap.

**Guardrails:**
- Resolver truncates STT output to a configurable token budget (e.g. 4000 tokens) with a trailing `[…truncated, X seconds of audio omitted]`.
- If truncation is hit, surface it to the user: "I transcribed your 12-minute voice note and kept the first ~4000 tokens; let me know if you want the rest."
- Long audio is also a candidate for chunked STT + summary, but that is v2 — see Open Questions.

### 6. Inbound media download fails or times out

Telegram's `getFile` can time out, return 404 for already-deleted media, or fail on bad `file_id`. The blob is never written, but the resolver still tries to read it.

**Guardrails:**
- `downloadMedia` is wrapped in a timeout (e.g. 30s) and returns a typed error, not an exception.
- The resolver treats a missing blob as a user-visible failure: "I received your photo but couldn't download it from Telegram — try sending it again."
- The blob store write is atomic: bytes go to a temp file, then `rename` to the final `sha256`-named path. A partial write never produces a readable blob.

### 7. Blob store grows unbounded

A long-running Alfred with lots of inbound media fills the disk. This is the failure mode the `BLOB_STORE_PATH` design must prevent.

**Guardrail (recommended default):**
- LRU eviction on a per-`blobId` access timestamp.
- A configurable on-disk size cap (e.g. `BLOB_STORE_MAX_BYTES=2GB`); once exceeded, oldest blobs are evicted until under cap.
- Periodic sweep (e.g. every hour) rather than on every write, so chat latency isn't paid for cleanup.
- Blob eviction never invalidates an in-flight turn — if a blob is referenced by an active resolver and gets evicted, the resolver re-downloads from the channel (with a re-fetch budget) before declaring failure.

These are not in the spec yet; they should be added to the blob store design before the keystone ships.

### 8. TTS synthesis latency blocks the user

A cloud TTS round-trip on a long reply (think 500 words) can take 5–10 seconds. The user sees nothing during that window, which feels broken.

**Guardrails:**
- The text reply is sent *first*, immediately. The voice reply is synthesized asynchronously and posted as a follow-up attachment.
- A short interim message ("sending voice reply…") is shown if synthesis exceeds a threshold (e.g. 3s).
- TTS is opt-in via env (`TTS_PROVIDER=...` set ⇒ enabled, unset ⇒ text-only) and the "type only" command can disable it per-session.

### 9. Opt-out command is ambiguous

"Type only", "text only", "no voice", "stop sending audio" — natural language is messy. If the matcher is a fragile substring check, users will get inconsistent behavior and assume it's broken.

**Guardrail:** normalize the opt-out to a single canonical intent (`/type-only` slash command or a small set of natural-language triggers) and treat anything outside that set as a normal message. The opt-out state is per-session, not global.

### 10. Document text extraction returns empty content

PDFs of scanned images have no text layer. DOCX files can have content in odd places (headers, footnotes, comments). Naive extractors return empty strings, and the model confidently says "the document is empty."

**Guardrail:** if extraction returns <50 chars or no extractable text, surface "I opened the document but couldn't extract text — it may be a scanned PDF" and attach a metadata-only summary (page count, file size) so the user can decide.

---

## Open questions

- **Vision model support** — does the current default model handle image input? If not, image attachments need an alternate path (e.g. OCR tool, or a vision-capable model switch).
- **TTS voice cloning / per-user voice persistence** — out of scope for v1; single default voice is acceptable.
- **Document text extraction library** — needed formats: PDF, DOCX, plain text. Library choice is undecided.
- **Blob store size limits / cleanup** — retention policy, on-disk size cap, and eviction strategy are unspecified.
- **Group chat attachments** — does the same flow apply, or do group channels need separate handling?

---

## Non-goals (v1)

- Voice cloning or per-user TTS voices
- Live voice (real-time duplex) — voice notes only
- Image generation outbound
- Video understanding beyond metadata + first-frame extract
