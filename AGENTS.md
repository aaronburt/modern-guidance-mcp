# AGENTS.md

Guidance for AI agents and humans working **on this repository**. This is not user-facing documentation.

Scope, so you edit the right file:

| You want to… | Edit |
| --- | --- |
| Learn how to *use* the server | `README.md` |
| Change how the server *tells models* to use it | `SERVER_INSTRUCTIONS` in `server.mjs` |
| Change how the server *works* | `server.mjs` |

Guidance for models consuming this server is **not** here. It ships in the `instructions` field of the MCP `initialize` response (`SERVER_INSTRUCTIONS` in `server.mjs`), which is the only channel a client reliably reads. A markdown file in this repo is invisible to clients — they never read our filesystem.

## Project shape

One file, two tools, no build step, no framework, three runtime dependencies. The point is that `server.mjs` is comprehensible end-to-end in a single sitting.

If a change tempts you toward Express, a bundler, TypeScript, or a `lib/` directory, that is a signal to find a smaller fix — not permission to restructure. The upstream SDK already supplies HTTP routing, validation, and JSON-RPC handling. Add a dependency only when it replaces real code you would otherwise write.

## Invariants that break silently

These fail without an error message. Verify each still holds after any edit here.

- **The search cache key must include `limit`** (`server.mjs:41`). It is `` `${limit}\n${query}` ``. Revert it to the bare query string and a cached 5-result payload silently satisfies a `limit: 20` request — wrong answers, clean exit, no warning.
- **One transport per request.** In stateless mode the SDK requires a fresh `StreamableHTTPServerTransport` per request or concurrent clients collide on message IDs. Caching the `McpServer` across requests is fine; caching the transport is not.
- **`search` → `retrieve` is an upstream contract, not ours.** Guide IDs are filenames inside `modern-web-guidance`, currently `0.0.x` — a package that renames things between releases. All 161 searchable IDs resolved to a real file as of this writing, but that is a property of the dependency, not this code. After bumping the dependency, run the test suite before assuming.
- **Do not relax the SDK's `Accept` / `Content-Type` validation.** It rejects browser-shaped requests (406 / 415). With no authentication on this server, that check is the only barrier against DNS rebinding. If you need CORS, you need auth first.

## Performance model

Embedding inference runs in a dedicated worker thread off the main event loop.

- Distinct queries cost ~300ms each and **serialize** in the worker thread.
- Repeating an identical `(query, limit)` pair is memoised and returns in ~1ms. Concurrent identical in-flight searches are deduped via a promise cache.
- The first search additionally loads a ~14MB index in the worker isolate.
- Because inference is offloaded to the worker thread, main thread HTTP handling and `/healthz` respond in ~1-3ms without blocking during cold searches.

Memoization and in-flight dedupe are the primary latency levers.

## Testing

`test.mjs` is a black-box HTTP suite. **It does not start the server** — run one first, then `MCP_URL=... npm test`.

For a new tool, cover three things: it appears in `tools/list`, bad input is rejected, and a valid call round-trips. Assert on `result.isError === true` for tool-level failures — that is the verified response shape — rather than accepting either that or a JSON-RPC error. Include assertion messages; a bare `assert(x)` tells the next reader nothing.

Latency thresholds in section 5 are calibrated to one machine. Widen them deliberately rather than deleting them, and say why in a comment.

## Deploy constraints

`docker-compose.yml` caps the container at 512MB with `--max-old-space-size=400`. Observed usage is 253MB idle after warmup, peaking around 355MB under load.

A new dependency can push past the limit, and the failure mode is an OOM `SIGKILL` plus a restart loop — not a JS heap error, so it presents as unexplained instability. If you change one memory number, change both.

The image is `gcr.io/distroless/nodejs24-debian12:nonroot`: no shell, no `curl`, no package manager. Use TCP probes or the app's `/healthz`.

## Known open items

None at present. Previous items (in-flight cache dedupe, hung socket after headers sent, nearest-rank p95 percentile, version drift from package.json, 5xx error text leaking, search-to-retrieve contract testing, healthz method restrictions, graceful drain on shutdown, and cross-platform stdio) have been resolved.


