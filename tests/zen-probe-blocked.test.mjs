// 10-18: an IP ban (403 FreeTierError) read as rc=2 "cooling", which the
// watcher keeps quiet by design — 18h of outage, zero alerts. rc=3 must win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = new URL('../scripts/zen-free-probe.mjs', import.meta.url).pathname;

function run(status) {
  const dir = mkdtempSync(join(tmpdir(), 'zenprobe-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  writeFileSync(join(dir, 'key'), ''); // empty key: abort() without touching the network
  writeFileSync(join(dir, 'backup'), 'x');
  return spawnSync(process.execPath, [probe, '--quiet'], {
    env: { ...process.env, JEV_ZEN_STATUS_FILE: join(dir, 'status.json'), JEV_API_KEY_FILE: join(dir, 'key'), JEV_ZEN_BACKUP_KEY_FILE: join(dir, 'backup') },
  }).status;
}

const future = Date.now() + 3600_000;
test('IP ban exits 3 even while the backup covers it', () => {
  assert.equal(run({ ok: false, cooldown_until: future, blocked: true }), 3);
});
test('quota cooldown with a backup stays 2', () => {
  assert.equal(run({ ok: false, cooldown_until: future, blocked: false }), 2);
});

// 10-19: during the ban every 403 in the usage ledger came from this probe, hourly.
async function hits(status) {
  const dir = mkdtempSync(join(tmpdir(), 'zenprobe-'));
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  writeFileSync(join(dir, 'key'), 'k');
  writeFileSync(join(dir, 'backup'), 'x');
  let n = 0;
  const srv = createServer((req, res) => { n += 1; res.writeHead(403); res.end('{"error":{"type":"FreeTierError"}}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [probe, '--quiet'], {
    env: { ...process.env, JEV_ZEN_STATUS_FILE: join(dir, 'status.json'), JEV_API_KEY_FILE: join(dir, 'key'), JEV_ZEN_BACKUP_KEY_FILE: join(dir, 'backup'), JEV_ZEN_BASE_URL: `http://127.0.0.1:${srv.address().port}`, JEV_USAGE_LOG: 'off' },
  });
  const rc = await new Promise((r) => child.on('exit', r));
  srv.close();
  return { n, rc };
}
test('inside a ban cooldown the probe does not call Zen', async () => {
  assert.deepEqual(await hits({ ok: false, cooldown_until: future, blocked: true }), { n: 0, rc: 3 });
});
test('after the cooldown lapses the probe does call Zen (the stub is wired)', async () => {
  const r = await hits({ ok: false, cooldown_until: Date.now() - 1000, blocked: true });
  assert.ok(r.n >= 1, `expected a network call, got ${r.n}`);
});
