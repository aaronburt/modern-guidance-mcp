import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const BASE_URL = process.env.MCP_URL ?? `http://localhost:${process.env.PORT ?? '8080'}`;

function parseMcpResponse(text) {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (line) {
    return JSON.parse(line.slice(6));
  }
  return JSON.parse(text);
}

async function sendMcp(method, params, id = 1) {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  return parseMcpResponse(text);
}

function calculateStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return {
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    avg: Math.round(sum / sorted.length),
    p50: Math.round(percentile(0.5)),
    p90: Math.round(percentile(0.9)),
    p95: Math.round(percentile(0.95)),
  };
}

async function runProtocolTests() {
  console.log(`[1/5] Running protocol & health checks against ${BASE_URL}...`);

  const healthRes = await fetch(`${BASE_URL}/healthz`);
  assert.strictEqual(healthRes.status, 200, 'GET /healthz should respond 200');
  const healthJson = await healthRes.json();
  assert.deepStrictEqual(healthJson, { ok: true }, 'GET /healthz body should be { ok: true }');
  console.log('  ✓ GET /healthz responded 200 OK');

  const headHealthRes = await fetch(`${BASE_URL}/healthz`, { method: 'HEAD' });
  assert.strictEqual(headHealthRes.status, 200, 'HEAD /healthz should respond 200');
  const headHealthText = await headHealthRes.text();
  assert.strictEqual(headHealthText, '', 'HEAD /healthz body must be empty');
  console.log('  ✓ HEAD /healthz responded 200 with empty body');

  const postHealthRes = await fetch(`${BASE_URL}/healthz`, { method: 'POST' });
  assert.strictEqual(postHealthRes.status, 405, 'POST /healthz should be rejected with 405');
  console.log('  ✓ POST /healthz rejected with 405');

  const deleteHealthRes = await fetch(`${BASE_URL}/healthz`, { method: 'DELETE' });
  assert.strictEqual(deleteHealthRes.status, 405, 'DELETE /healthz should be rejected with 405');
  console.log('  ✓ DELETE /healthz rejected with 405');

  const getMcpRes = await fetch(`${BASE_URL}/mcp`);
  assert.strictEqual(getMcpRes.status, 405, 'GET /mcp should respond 405');
  console.log('  ✓ GET /mcp rejected with 405 (stateless server)');

  const notFoundRes = await fetch(`${BASE_URL}/non-existent`);
  assert.strictEqual(notFoundRes.status, 404, 'GET /non-existent should respond 404');
  console.log('  ✓ GET /non-existent responded 404');

  const initData = await sendMcp('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-runner', version: '1.0.0' },
  }, 1);
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
  assert.strictEqual(initData.result?.serverInfo?.name, 'modern-web-guidance', 'Server name mismatch');
  assert.strictEqual(initData.result?.serverInfo?.version, pkg.version, 'Server version should match package.json');
  console.log(`  ✓ POST /mcp initialize succeeded with version ${pkg.version}`);

  const listData = await sendMcp('tools/list', {}, 2);
  const toolNames = listData.result?.tools?.map((t) => t.name) ?? [];
  assert(toolNames.includes('search'), 'tools/list missing search');
  assert(toolNames.includes('retrieve'), 'tools/list missing retrieve');
  console.log(`  ✓ POST /mcp tools/list discovered: ${toolNames.join(', ')}`);
}

async function runValidationAndBoundaryTests() {
  console.log('\n[2/5] Running input validation & boundary checks...');

  const invalidJsonRes = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"malformed": ',
  });
  assert.strictEqual(invalidJsonRes.status, 400, 'Malformed JSON should return 400');
  console.log('  ✓ Invalid JSON rejected with 400 Bad Request');

  const oversizedBody = 'x'.repeat(1024 * 1024 + 100);
  const tooLargeRes = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: oversizedBody,
  });
  assert.strictEqual(tooLargeRes.status, 413, 'Oversized payload should return 413');
  console.log('  ✓ Payload exceeding 1 MB rejected with 413 Payload Too Large');

  const emptySearch = await sendMcp('tools/call', {
    name: 'search',
    arguments: { query: 'zzz_non_matching_query_12345_xyz' },
  }, 10);
  const emptySearchContent = emptySearch.result?.content?.[0]?.text ?? '';
  assert(Array.isArray(JSON.parse(emptySearchContent)), 'Empty search should return JSON array');
  console.log('  ✓ Obscure search safely returned JSON array without crashing');

  const specialCharSearch = await sendMcp('tools/call', {
    name: 'search',
    arguments: { query: 'dialog & modal | "quotes" <tag> ^caret %percent' },
  }, 11);
  const specialCharContent = specialCharSearch.result?.content?.[0]?.text ?? '';
  assert(specialCharContent.length > 0, 'Special character search should return content');
  console.log('  ✓ Search query with special characters executed cleanly');

  const missingGuide = await sendMcp('tools/call', {
    name: 'retrieve',
    arguments: { guide_id: 'non-existent-guide-id' },
  }, 12);
  assert(missingGuide.error || missingGuide.result?.isError, 'Missing guide retrieve should return error response');
  console.log('  ✓ Missing guide retrieve returned error response cleanly');
}

async function runFunctionalTests() {
  console.log('\n[3/5] Running functional search & retrieve checks...');

  const searchData = await sendMcp('tools/call', {
    name: 'search',
    arguments: { query: 'popover invoker attribute' },
  }, 20);
  const searchContent = searchData.result?.content?.[0]?.text ?? '';
  const parsedGuides = JSON.parse(searchContent);
  assert(Array.isArray(parsedGuides) && parsedGuides.length > 0, 'Search should return non-empty array');
  assert(parsedGuides.some((g) => g.id.includes('popover') || g.id.includes('dialog')), 'Results should contain popover or dialog');
  console.log(`  ✓ Search returned ${parsedGuides.length} relevant guides`);

  const topGuideId = parsedGuides[0].id;
  const retrieveData = await sendMcp('tools/call', {
    name: 'retrieve',
    arguments: { guide_id: topGuideId },
  }, 21);
  const retrieveContent = retrieveData.result?.content?.[0]?.text ?? '';
  assert(retrieveContent.includes(topGuideId), 'Retrieved content should include guide ID');
  assert(retrieveContent.includes('# '), 'Retrieved content should include Markdown header');
  console.log(`  ✓ Retrieved full markdown for "${topGuideId}" (${retrieveContent.length} bytes)`);
}

async function runContractTests() {
  console.log('\n[4/5] Verifying search -> retrieve contract across all searchable guides...');

  const require = createRequire(import.meta.url);
  const vectorsGz = require.resolve('modern-web-guidance/skills/modern-web-guidance/use-cases.vectors.gen.json.gz');
  const vectorData = JSON.parse(gunzipSync(readFileSync(vectorsGz)).toString('utf-8'));
  const searchableGuideIds = [...new Set(vectorData.filter((d) => d.vector).map((d) => d.id))];

  assert(searchableGuideIds.length > 0, 'No searchable guide IDs found in vector index');

  const batchSize = 25;
  for (let i = 0; i < searchableGuideIds.length; i += batchSize) {
    const batch = searchableGuideIds.slice(i, i + batchSize);
    await Promise.all(batch.map(async (guideId, batchIdx) => {
      const id = 1000 + i + batchIdx;
      const res = await sendMcp('tools/call', {
        name: 'retrieve',
        arguments: { guide_id: guideId },
      }, id);
      assert(!res.error, `JSON-RPC error retrieving "${guideId}": ${JSON.stringify(res.error)}`);
      assert(!res.result?.isError, `Tool error retrieving "${guideId}": ${res.result?.content?.[0]?.text}`);
      const content = res.result?.content?.[0]?.text ?? '';
      assert(content.length > 0, `Empty content returned for guide "${guideId}"`);
      assert(content.includes(guideId), `Retrieved content for "${guideId}" missing header`);
    }));
  }
  console.log(`  ✓ All ${searchableGuideIds.length} searchable guide IDs successfully retrieved`);
}

async function runPerformanceProfiling() {
  console.log('\n[5/5] Profiling performance under load...');

  const testQueries = [
    'popover invoker attribute',
    'view transitions multi-page navigation',
    'css scroll-driven animations timeline',
    'container queries inline size',
    'dialog showModal light dismiss backdrop',
    'anchor positioning position-area',
    'content-visibility auto deferred render',
    'fetch priority lcp candidate image',
    'webgpu render pipeline compute shaders',
    'indexeddb async transactions storage',
  ];

  const searchLatencies = [];
  const queryCount = 20;

  for (let i = 0; i < queryCount; i++) {
    const q = testQueries[i % testQueries.length];
    const t0 = performance.now();
    await sendMcp('tools/call', {
      name: 'search',
      arguments: { query: q },
    }, 100 + i);
    searchLatencies.push(performance.now() - t0);
  }

  const sampleGuideIds = [
    'declarative-dialog-popover-control',
    'light-dismiss-a-dialog',
    'html',
    'accessibility',
  ];

  const retrieveLatencies = [];
  for (let i = 0; i < 10; i++) {
    const id = sampleGuideIds[i % sampleGuideIds.length];
    const t0 = performance.now();
    await sendMcp('tools/call', {
      name: 'retrieve',
      arguments: { guide_id: id },
    }, 200 + i);
    retrieveLatencies.push(performance.now() - t0);
  }

  const searchStats = calculateStats(searchLatencies);
  const retrieveStats = calculateStats(retrieveLatencies);

  console.log('\n=== Profiling Summary ===');
  console.table({
    'Semantic Search (20 calls)': {
      'Min (ms)': searchStats.min,
      'Avg (ms)': searchStats.avg,
      'P50 (ms)': searchStats.p50,
      'P90 (ms)': searchStats.p90,
      'P95 (ms)': searchStats.p95,
      'Max (ms)': searchStats.max,
    },
    'Guide Retrieve (10 calls)': {
      'Min (ms)': retrieveStats.min,
      'Avg (ms)': retrieveStats.avg,
      'P50 (ms)': retrieveStats.p50,
      'P90 (ms)': retrieveStats.p90,
      'P95 (ms)': retrieveStats.p95,
      'Max (ms)': retrieveStats.max,
    },
  });

  assert(searchStats.avg < 300, `Average search latency too high: ${searchStats.avg}ms`);
  assert(retrieveStats.avg < 100, `Average retrieve latency too high: ${retrieveStats.avg}ms`);
}

async function main() {
  const suiteStart = performance.now();
  await runProtocolTests();
  await runValidationAndBoundaryTests();
  await runFunctionalTests();
  await runContractTests();
  await runPerformanceProfiling();
  const totalElapsed = Math.round(performance.now() - suiteStart);
  console.log(`\nAll test suites passed successfully in ${totalElapsed}ms!\n`);
}

main().catch((err) => {
  console.error('\nSuite execution failed:', err);
  process.exit(1);
});
