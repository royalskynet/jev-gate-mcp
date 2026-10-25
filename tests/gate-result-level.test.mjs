import assert from 'node:assert/strict';
import { withResultLevel, RESULT_LEVEL } from '../plugin/lib/gate.js';
import { blockDecision } from '../plugin/hooks/gate.js';

// Outcome claims get the result-level qualifier; action claims stay as written.
const [fixed, edited, works] = withResultLevel(['已修好 Stop hook', '改了 gate.js 第 40 行', 'the gateway works now']);
assert.ok(fixed.endsWith(RESULT_LEVEL));
assert.equal(edited, '改了 gate.js 第 40 行');
assert.ok(works.endsWith(RESULT_LEVEL));
assert.equal(withResultLevel([fixed])[0], fixed, 'qualifier is added once');
// The agent sees its own claim, not the qualifier, and is told what kind of evidence is missing.
const out = blockDecision({ verdict: 'not_addressed', gate: 'auto', claim: fixed });
const text = JSON.stringify(out);
assert.match(text, /未證明結果/);
assert.ok(!text.includes('result-level claim'));
console.log('ok: outcome claims need result-level evidence');
