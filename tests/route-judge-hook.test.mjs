// ~/.claude/hooks/route-judge.mjs 走 cascade 的四條路（PLAN-20261020-routejudge-laya-lane B）：
// daemon 在 → cascade、不送 lane header（白名單由 daemon 決定）；daemon 沒開 → 直打；
// 非 loopback／沒設鍵 → 直打。直打用 fake provider，cascade 用本機假伺服器，零 token。
// hook 不在 repo 裡（正本 ~/.claude/hooks），沒裝的機器跳過。
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

const HOOK = path.join(os.homedir(), '.claude/hooks/route-judge.mjs');
const skip = !fs.existsSync(HOOK) && 'route-judge hook not installed';

const run = (dir, cc) => new Promise((resolve, reject) => {
  fs.writeFileSync(path.join(dir, 'cc.json'), JSON.stringify(cc));
  const p = execFile('node', [HOOK], { env: { ...process.env, JEV_PROVIDER: 'fake', NODE_TEST_CONTEXT: '',
    ROUTE_JUDGE_LOG: path.join(dir, 'rj.log'), ROUTE_JUDGE_CASCADE_FILE: path.join(dir, 'cc.json') } },
  (e, out) => (e ? reject(e) : resolve(JSON.parse(out))));
  // 危險詞跳過「session 第一則」閘，不需要 transcript。
  p.stdin.end(JSON.stringify({ prompt: '幫我把這個服務部署到正式機上，順便改設定', cwd: os.tmpdir(), routes: [] }));
});
const lastVia = (dir) => fs.readFileSync(path.join(dir, 'rj.log'), 'utf8').trim().split('\n').at(-1).match(/via=(\S+)/)?.[1];

test('route-judge hook: cascade when the daemon is up, direct otherwise', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-'));
  const hits = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      hits.push({ caller: req.headers['x-jev-caller'], lane: req.headers['x-jev-laya-qtypes'], qs: Object.keys(JSON.parse(b).questions).sort().join() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { tier: { type: 'choice', choice: 'L2', confidence: 0.9 },
        ambiguous: { type: 'noul', noul: 0.8 }, wrong_reading_costly: { type: 'noul', noul: 0.7 } } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const up = await run(dir, { 'route-judge': `http://127.0.0.1:${port}` });
    assert.equal(lastVia(dir), 'cascade');
    assert.equal(up.tier, 'L2');
    assert.equal(up.ask_first, true);
    // routes 空：route 題只剩 none 一個選項，jevwire 會拒，所以整題不送。
    assert.deepEqual(hits, [{ caller: 'route-judge', lane: undefined, qs: 'ambiguous,tier,wrong_reading_costly' }]);

    srv.close(); await new Promise((r) => setTimeout(r, 50));
    const down = await run(dir, { 'route-judge': `http://127.0.0.1:${port}` });
    assert.equal(lastVia(dir), 'cascade-down');
    assert.equal(down.status, 'ok');

    await run(dir, { 'route-judge': 'http://100.64.0.2:8793' });
    assert.equal(lastVia(dir), 'direct', 'tailnet daemon is laya-only; route-judge needs the cloud judge');
    await run(dir, { compact: `http://127.0.0.1:${port}` });
    assert.equal(lastVia(dir), 'direct');
    assert.equal(hits.length, 1);
  } finally { srv.close(); }
});
