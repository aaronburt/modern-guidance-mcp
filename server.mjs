import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const { version } = require('./package.json');

if (!isMainThread) {
  const searchModPath = pathToFileURL(require.resolve('modern-web-guidance/skills/modern-web-guidance/search.mjs')).href;
  const { searchUseCases } = await import(searchModPath);

  parentPort.on('message', async ({ id, query, limit }) => {
    try {
      const results = await searchUseCases(query, limit);
      parentPort.postMessage({ id, results });
    } catch (err) {
      parentPort.postMessage({ id, error: err.message ?? String(err) });
    }
  });

  searchUseCases('warmup').catch(() => {});
} else {
  const skillPkg = require.resolve('modern-web-guidance/skills/modern-web-guidance/package.json');
  const guidesDir = join(skillPkg, '../guides');

  const guideMap = new Map();
  for (const category of readdirSync(guidesDir, { withFileTypes: true })) {
    if (category.isDirectory()) {
      for (const file of readdirSync(join(guidesDir, category.name))) {
        if (file.endsWith('.md')) {
          guideMap.set(file.slice(0, -3), join(guidesDir, category.name, file));
        }
      }
    }
  }

  const searchCache = new Map();
  const SEARCH_CACHE_MAX = 200;
  const SEARCH_DEFAULT_LIMIT = 5;
  const SEARCH_MAX_LIMIT = 20;

  let searchWorker = null;
  let nextSearchId = 1;
  const pendingSearches = new Map();

  function getSearchWorker() {
    if (!searchWorker) {
      searchWorker = new Worker(new URL(import.meta.url));
      searchWorker.on('message', ({ id, results, error }) => {
        const pending = pendingSearches.get(id);
        if (!pending) return;
        pendingSearches.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(results);
      });
      searchWorker.on('error', (err) => {
        for (const pending of pendingSearches.values()) {
          pending.reject(err);
        }
        pendingSearches.clear();
        searchWorker = null;
      });
      searchWorker.on('exit', () => {
        for (const pending of pendingSearches.values()) {
          pending.reject(new Error('Search worker exited unexpectedly'));
        }
        pendingSearches.clear();
        searchWorker = null;
      });
    }
    return searchWorker;
  }

  function runSearchInWorker(query, limit) {
    return new Promise((resolve, reject) => {
      const worker = getSearchWorker();
      const id = nextSearchId++;
      pendingSearches.set(id, { resolve, reject });
      worker.postMessage({ id, query, limit });
    });
  }

  async function executeSearch(query, limit = SEARCH_DEFAULT_LIMIT) {
    const key = `${limit}\n${query}`;
    const cached = searchCache.get(key);
    if (cached !== undefined) return cached;

    const promise = (async () => {
      try {
        const results = await runSearchInWorker(query, limit);
        return results?.length ? JSON.stringify(results) : '[]';
      } catch (err) {
        searchCache.delete(key);
        throw err;
      }
    })();

    if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.clear();
    searchCache.set(key, promise);
    return promise;
  }

  async function executeRetrieve(guideId) {
    const filePath = guideMap.get(guideId);
    if (!filePath) {
      throw new Error(`No guide found for use case: ${guideId}`);
    }
    const content = await readFile(filePath, 'utf-8');
    return `\n--- Guide for ${guideId} ---\n${content}`;
  }

  const SERVER_INSTRUCTIONS = `Guidance for modern web platform features: CSS, HTML, JS, forms, performance, accessibility, security, and PWA.

Workflow: call search first, then retrieve with an id it returns. Never guess or hardcode guide ids — they are filenames from an upstream package that renames them between releases.

An empty array from search is a valid answer, not an error: results below a 0.3 similarity threshold are withheld. Rephrase with different vocabulary rather than concluding the feature does not exist.

Check the similarity field to judge confidence, and prefer guides above ~0.5.

Use limit to trade tokens for recall: the default 5 suits a specific question, while broad or exploratory ones ("animate a modal") benefit from 10-20. Retrieve is cheap but each guide is 10-16KB of Markdown, so fetch only the ones you will actually read.

Repeated searches are memoised per (query, limit) pair and return in ~1ms. Distinct queries cost ~300ms each and are processed serially, so parallel searches will not be faster.`;

  function buildServer() {
    const server = new McpServer(
      { name: 'modern-web-guidance', version },
      { instructions: SERVER_INSTRUCTIONS },
    );

    server.registerTool(
      'search',
      {
        title: 'Search modern web guidance',
        description: 'Semantic search over modern web platform guides. Returns matching guide IDs and use cases.',
        inputSchema: {
          query: z.string().min(1).describe('What you want to build or do, e.g. "animate a dialog modal backdrop"'),
          limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT)
            .optional()
            .describe(`Maximum guides to return, ${SEARCH_DEFAULT_LIMIT} by default. Raise for broad questions, lower to save tokens.`),
        },
      },
      async ({ query, limit }) => ({
        content: [{ type: 'text', text: await executeSearch(query, limit) }],
      }),
    );

    server.registerTool(
      'retrieve',
      {
        title: 'Retrieve a guide',
        description: 'Fetch the full Markdown guide for a guide ID returned by search.',
        inputSchema: { guide_id: z.string().min(1).describe('Guide ID, e.g. "animate-to-from-top-layer"') },
      },
      async ({ guide_id }) => ({
        content: [{ type: 'text', text: await executeRetrieve(guide_id) }],
      }),
    );

    return server;
  }

  async function readBody(req) {
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 1024 * 1024;
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      const err = new Error('Invalid JSON body');
      err.statusCode = 400;
      throw err;
    }
  }

  async function main() {
    if (process.env.MCP_TRANSPORT === 'stdio' || process.argv.includes('--stdio')) {
      const server = buildServer();
      await server.connect(new StdioServerTransport());
      console.error('modern-web-guidance MCP (stdio) running');
      return;
    }

    const port = Number(process.env.PORT ?? 8080);
    const http = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (url.pathname === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname === '/mcp' && req.method === 'POST') {
        try {
          const body = await readBody(req);
          const server = buildServer();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            transport.close();
            server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch (err) {
          const status = err.statusCode ?? 500;
          if (status >= 500 || res.headersSent) {
            console.error(err);
          }
          if (!res.headersSent) {
            const message = status >= 500 ? 'Internal server error' : (err.message ?? String(err));
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          } else {
            res.destroy();
          }
        }
        return;
      }

      if (url.pathname === '/mcp' && req.method === 'GET') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Stateless server: POST only, no SSE stream' }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    let closing = false;
    const cleanup = () => {
      if (closing) return;
      closing = true;
      http.closeIdleConnections?.();
      http.close((err) => {
        searchWorker?.terminate();
        process.exit(err ? 1 : 0);
      });
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);

    http.listen(port, () => console.error(`modern-web-guidance MCP listening on :${port} (/mcp)`));
    getSearchWorker();
  }

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
