import test from 'node:test';
import assert from 'node:assert/strict';
import { triage } from '../../agent-glue/src/triage.js';
import { layaNoulCheck } from '../../agent-glue/src/verify.js';
import { retrieve } from '../../agent-glue/src/retriever.js';

test('legacy local judge cannot override Jev difficulty or trigger a second inference', async () => {
  let localCalls = 0;
  const r = await triage({ text: '請整理筆記' }, {
    transport: { evaluate: async () => ({ answers: {
      difficulty: { score: 3, confidence: 1 }, kind: { choice: 'writing' }, costly_mistake: { noul: 0 },
    } }) },
    localJudge: async () => { localCalls++; return { difficulty: { score: 0, confidence: 1 } }; },
  });
  assert.equal(localCalls, 0);
  assert.equal(r.tier, 'hard');
});

test('completion opinion sends execution evidence and rejects invalid probabilities', async () => {
  const ctx = { claim: 'done', evidence: [{ kind: 'test', ok: true, text: 'passed' }] };
  let seen;
  const r = await layaNoulCheck(ctx, async (state) => { seen = state; return { noul: { noul: 0.8 } }; });
  assert.deepEqual(seen, ctx);
  assert.equal(r.noul, 0.8);
  assert.equal(await layaNoulCheck(ctx, async () => ({ noul: { noul: 1455 } })), null);
});

test('retrieval scores each candidate with Jev and preserves original order on partial coverage', async () => {
  const hits = [{ file: 'a.md' }, { file: 'b.md' }];
  const opts = { topN: 2, execFile: async () => ({ stdout: JSON.stringify({ hits }) }),
    transport: { evaluate: async ({ state, questions }) => {
      assert.equal(state.query, 'symptom');
      assert.equal(Object.keys(questions).length, 2);
      assert.equal(questions.fix_0.criteria.length, 4);
      return { coverage: 'complete', answers: { fix_0: { score: 1 }, fix_1: { score: 3 } } };
    } },
  };
  assert.equal((await retrieve('symptom', opts))[0].file, 'b.md');
  opts.transport.evaluate = async () => ({ coverage: 'incomplete', answers: {} });
  assert.deepEqual(await retrieve('symptom', opts), hits);
});
