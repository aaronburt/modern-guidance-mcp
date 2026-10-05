# modern-web-guidance MCP

A thin MCP server exposing [`modern-web-guidance`](https://www.npmjs.com/package/modern-web-guidance) over the Model Context Protocol. Semantic search and guide retrieval run in-process against pre-warmed embeddings — no CLI subprocess, no network calls.

Wraps **162 Markdown guides** across 16 categories (CSS, performance, forms, UI behaviors, security, and more). 161 of them are reachable through `search`; all 162 can be fetched by ID with `retrieve`.

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/aaronburt/modern-guidance-mcp.git)

## Tools

### `search(query, limit?)`

Semantic search over the guide index. Returns up to `limit` guides (**5** by default, max **20**) above a **0.3** similarity threshold, as a JSON array:

```json
[{
  "id": "declarative-dialog-popover-control",
  "description": "...",
  "category": "ui-behaviors",
  "featuresUsed": ["popover", "dialog"],
  "tokenCount": 10571,
  "similarity": 0.7412
}]
```

Every `id` returned here is a valid argument for `retrieve`.

Raise `limit` for broad questions where the best guide may not rank first; lower it to save tokens when you have a clear idea what you're after. Results are memoised per `(query, limit)` pair, so a repeat call is free.

### `retrieve(guide_id)`

Full Markdown text of a single guide. Guide IDs are the filenames under `guides/<category>/`, minus the `.md` extension.

## Performance

Measured on Node 24.21, local SSD, single client:

| Operation | Latency |
| --- | --- |
| `search` — cache miss (cold) | 265–320 ms |
| `search` — cache hit (warm) | 1–3 ms |
| `retrieve` | 2–3 ms |

Cold searches run embedding inference on the main thread, so **requests do not overlap**: three concurrent cold searches completed at 313 ms, 600 ms, and 927 ms. Eight distinct cold queries in parallel took 2276 ms — the same as issuing them one at a time. Warm cache hits are unaffected.

Successful search results are memoised in-process (200 entries, cleared wholesale on overflow), so repeated queries are effectively free. The first call also pays a one-time ~14 MB index load.

## Run locally

```bash
npm install
npm start                  # HTTP on :8080
```

For stdio transport (desktop clients):

```bash
npm run start:stdio
# or:
node server.mjs --stdio
# or:
MCP_TRANSPORT=stdio node server.mjs
```

## Client configuration

Streamable HTTP:

```json
{
  "mcpServers": {
    "modern-web-guidance": {
      "type": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

stdio:

```json
{
  "mcpServers": {
    "modern-web-guidance": {
      "command": "node",
      "args": ["/absolute/path/to/thin/server.mjs"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

## Endpoints

| Route | Method | Behaviour |
| --- | --- | --- |
| `/mcp` | `POST` | JSON-RPC. Bodies over 1 MB are rejected with `413`; malformed JSON with `400`. |
| `/mcp` | `GET` | `405`. This is a stateless server — no SSE stream. |
| `/healthz` | `GET`, `HEAD` | `{"ok":true}`. Liveness only; it returns `ok` before the embedding model finishes warming. |
| anything else | any | `404` |

Clients must send `Accept: application/json, text/event-stream`. Requests without both are rejected with `406`.

## Tests

`test.mjs` is a black-box HTTP suite — **it does not start the server**. Run the server first, then:

```bash
npm test                              # assumes http://localhost:8080
MCP_URL=http://localhost:9000 npm test
```

It covers protocol handshake, routing, input validation, functional search/retrieve, and a latency profile with thresholds (search avg < 300 ms, retrieve avg < 100 ms).

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port |
| `MCP_TRANSPORT` | `http` | Set to `stdio` for desktop clients |
| `ENABLE_FILE_LOGGING` | unset | Upstream passthrough. When `true`, search metadata is appended to `modern-web.log` in `MODERN_WEB_LOG_DIR` (default: cwd). Off by default; never phoned home either way. |

## Docker

Build and run locally:

```bash
docker compose up
```

Or run the prebuilt release image from GHCR:

```bash
docker compose -f docker-compose.release.yml up
```

Runs `gcr.io/distroless/nodejs24-debian12:nonroot` — no shell, no `curl`, no package manager. Use TCP probes or the app's own `/healthz`. Image size is roughly 280 MB, dominated by the embedding model and the 6 MB compressed vector index.

Compose caps the container at 512 MB with `--max-old-space-size=400`. Observed usage is 253 MB idle after warmup, peaking around 355 MB under load. Raise the heap cap and the container limit together — a container `SIGKILL` arrives before V8 reports heap exhaustion.

## Deploy to Google Cloud Run

Deploy directly to Google Cloud Run with one click:

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/aaronburt/modern-guidance-mcp.git)

## Known limitations

- **Cold searches serialize.** Embedding inference runs in a dedicated worker thread off the main thread; distinct cold queries are processed serially without blocking health checks or unrelated I/O.
- **No authentication.** The server binds all interfaces. Both tools are read-only, and the SDK's `Accept`/`Content-Type` validation rejects browser-shaped requests, so DNS-rebinding exposure is low — but do not expose this beyond localhost without adding auth.
- **`prompt-api` is not searchable.** It ships as a guide but has no vector entry, so `search` never returns it. `retrieve("prompt-api")` works.
- **Cache keys are raw.** `"dialog"`, `"Dialog"`, and `" dialog "` are three separate entries.

## Disclaimer

This project was built with AI assistance and reviewed by a human. The benchmarks above come from real measurements against the code in this repository, not estimates — but they reflect one machine and one workload, so treat them as a baseline rather than a guarantee. Verify anything that matters to you.
