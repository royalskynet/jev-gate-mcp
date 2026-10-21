// 10-18: an 18h IP ban never alerted — the watcher kept rc=2 quiet by design.
// rc=3 (ban) must push on the flip; a long rc=2 streak must push once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watch = new URL('../scripts/zen-free-watch.sh', import.meta.url).pathname;

function home(status) {
  const h = mkdtempSync(join(tmpdir(), 'zenwatch-'));
  mkdirSync(join(h, '.jevgate'));
  mkdirSync(join(h, '.creds', 'kv'), { recursive: true });
  mkdirSync(join(h, 'bin'));
  writeFileSync(join(h, '.jevgate', 'zen-free-status.json'), JSON.stringify(status));
  writeFileSync(join(h, '.creds', 'kv', 'OPENROUTER_SECOND_API_KEY.txt'), 'x'); // backup present
  // no Zen key file: the probe aborts without touching the network
  writeFileSync(join(h, 'bin', 'hpush'), `#!/bin/sh\necho "$1" >> ${h}/pushed\n`, { mode: 0o755 });
  return h;
}
const run = (h, extra = {}) => spawnSync('bash', [watch], {
  env: { PATH: `${h}/bin:${process.env.PATH}`, HOME: h, ...extra },
});
const pushed = (h) => existsSync(join(h, 'pushed')) ? readFileSync(join(h, 'pushed'), 'utf8') : '';
const future = Date.now() + 3600_000;

test('an IP ban pushes on the flip to rc=3', () => {
  const h = home({ ok: false, cooldown_until: future, blocked: true });
  run(h);
  assert.match(pushed(h), /封 IP/);
});

test('a quota cooldown is quiet until the streak cap, then pushes once', () => {
  const h = home({ ok: false, cooldown_until: future, blocked: false });
  const cap = { ZEN_WATCH_STREAK_MAX: '2' };
  run(h, cap);
  assert.equal(pushed(h), '', 'one rc=2 is a planned swap');
  run(h, cap);
  assert.match(pushed(h), /連續 2 次/);
  run(h, cap);
  assert.equal(pushed(h).split('\n').filter(Boolean).length, 1, 'push once, not every hour');
});

// 10-19: the ban's end only showed in the next day's brief; 3→0 must push at once.
test('a lifted IP ban pushes on the flip 3→0, a plain 2→0 stays quiet', () => {
  const fakeNode = (h, rc) => writeFileSync(join(h, 'bin', 'node'), `#!/bin/sh\nexit ${rc}\n`, { mode: 0o755 });
  const h = home({ ok: true });
  fakeNode(h, 0);
  writeFileSync(join(h, '.jevgate', 'zen-watch.rc'), '3');
  run(h);
  assert.match(pushed(h), /解封/);
  const q = home({ ok: true });
  fakeNode(q, 0);
  writeFileSync(join(q, '.jevgate', 'zen-watch.rc'), '2');
  run(q);
  assert.equal(pushed(q), '', 'quota swap back is planned, no push');
});
