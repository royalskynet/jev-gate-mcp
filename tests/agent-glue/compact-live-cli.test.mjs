// Guard for the `compact-live` CLI subcommand: it wires a real Jev judge over
// a Node `$` host, so the tests here run the actual cli.mjs in a child process
// against a local `node:http` fake server — no real network, no real key.
// Three things are pinned: a drop judge elides large tool payloads, no payload
// or user request crosses the wire even when the caller asks for heads, and a
// missing key answers `reason: "no key"` with exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'agent-glue', 'cli.mjs');

function startServer(status = 200) {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      // Connection: close so undici's keep-alive pool releases the socket;
      // otherwise server.close() waits on a live connection and the test hangs.
      res.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
      // Drop every question asked, whatever the batch: judgePairs keys them p0, p1, ...
      const answers = Object.fromEntries(Object.keys(JSON.parse(body).questions ?? {}).map((k) => [k, { choice: 'drop' }]));
      res.end(JSON.stringify({ answers }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, bodies, port: server.address().port }));
  });
}

// Async on purpose: the fake server lives in this process, and spawnSync would
// block its event loop, so the child's judge request never gets an answer.
function runCli(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'compact-live'], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

// pinFirst defaults to 1 and pinLast to 8, so the transcript needs a pinned
// head, a pinned tail, and an unpinned middle carrying the bulky pair.
function bigMessages() {
  const bulk = 'x'.repeat(9000);
  const tail = Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `tail ${i}` }));
  return [
    { role: 'user', content: 'find the slow step' },
    { role: 'assistant', content: 'checking the tree', tool_calls: [{ id: 'a', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm ls --all' }) + bulk } }] },
    { role: 'tool', tool_call_id: 'a', content: bulk },
    ...tail,
  ];
}

test('compact-live: a drop judge elides large tool payloads, compacted is true', async () => {
  const { server, port } = await startServer();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compact-live-'));
    const keyFile = path.join(dir, 'key.txt');
    fs.writeFileSync(keyFile, 'test-key');
    const r = await runCli(
      { messages: bigMessages() },
      { JEV_ENDPOINT: `http://127.0.0.1:${port}/zen/v1/systemone`, JEV_API_KEY_FILE: keyFile },
    );
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.equal(v.compacted, true);
    assert.ok(v.reducedBy > 9000, `reducedBy=${v.reducedBy}`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('compact-live: no payload or user request crosses the wire, even with judgeHeadChars set', async () => {
  const { server, bodies, port } = await startServer();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compact-live-'));
    const keyFile = path.join(dir, 'key.txt');
    fs.writeFileSync(keyFile, 'test-key');
    // The caller asks for 500-char heads; the CLI must ignore that and pin
    // judgeHeadChars to 0, so the judge sees names and sizes only.
    const r = await runCli(
      { messages: bigMessages(), judgeHeadChars: 500 },
      { JEV_ENDPOINT: `http://127.0.0.1:${port}/zen/v1/systemone`, JEV_API_KEY_FILE: keyFile },
    );
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.ok(bodies.length > 0, 'the judge must have been called');
    for (const body of bodies) {
      assert.equal(body.state.user_request, '', 'user request must stay empty');
      for (const pair of Object.values(body.state.pairs)) {
        assert.equal(pair.result, '', 'no result payload crosses the wire');
        assert.equal(pair.arguments, '', 'no argument payload crosses the wire');
      }
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// The free Zen quota runs out daily (429 FreeUsageLimitError). judgePair
// answers 'keep' on a failed call, so without an abort every pair would still
// cost a round trip; the host would pay N x latency to get nothing back.
test('compact-live: a 429 judge aborts the pass after one call, reason judge-http-429', async () => {
  const { server, bodies, port } = await startServer(429);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compact-live-'));
    const keyFile = path.join(dir, 'key.txt');
    fs.writeFileSync(keyFile, 'test-key');
    const two = bigMessages();
    // A second unpinned pair, so "stops after one" is distinguishable from "judged all".
    two.splice(3, 0,
      { role: 'assistant', content: 'again', tool_calls: [{ id: 'b', function: { name: 'Bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'b', content: 'y'.repeat(9000) });
    const r = await runCli(
      { messages: two },
      { JEV_ENDPOINT: `http://127.0.0.1:${port}/zen/v1/systemone`, JEV_API_KEY_FILE: keyFile },
    );
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.equal(v.compacted, false);
    assert.equal(v.reason, 'judge-http-429');
    assert.equal(bodies.length, 1, 'no further judge calls after the first failure');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// One request per pair made a 300-pair Hermes pass 300 sequential round trips:
// past the 20 s subprocess deadline and through Zen free's daily quota. Pairs
// are now batched (40 per request), so 60 pairs cost 2 requests, not 60.
test('compact-live: many pairs are judged in batched requests, not one each', async () => {
  const { server, bodies, port } = await startServer();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compact-live-'));
    const keyFile = path.join(dir, 'key.txt');
    fs.writeFileSync(keyFile, 'test-key');
    const messages = bigMessages();
    const extra = [];
    for (let k = 0; k < 59; k++) {
      extra.push(
        { role: 'assistant', content: '', tool_calls: [{ id: `m${k}`, function: { name: 'Read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: `m${k}`, content: 'z'.repeat(500) },
      );
    }
    messages.splice(3, 0, ...extra);
    const r = await runCli(
      { messages },
      { JEV_ENDPOINT: `http://127.0.0.1:${port}/zen/v1/systemone`, JEV_API_KEY_FILE: keyFile },
    );
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.equal(bodies.length, 2, `60 pairs must cost 2 requests, got ${bodies.length}`);
    assert.equal(v.compacted, true);
    assert.ok(v.reducedBy > 9000 + 59 * 500, `every pair's drop verdict must apply, reducedBy=${v.reducedBy}`);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('compact-live: no key file and no env key -> reason "no key", exit 0', async () => {
  const r = await runCli(
    { messages: bigMessages() },
    { JEV_API_KEY_FILE: '/nonexistent/jev-compact-live-key.txt', OPENROUTER_API_KEY: '' },
  );
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const v = JSON.parse(r.stdout);
  assert.equal(v.compacted, false);
  assert.equal(v.reason, 'no key');
});
