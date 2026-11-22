import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFacts, checkFacts, decisive, isFactClaim, sentences } from './index.js';

const REPLY = [
  '五種協議各自要另外繳月費。',
  '500U 是整套方案的月費。',
  '我推論 CODE 卡片可能要另外收費。',
  '要不要問供應商？',
  '今天天氣很好呢。',
].join('\n');

test('selectFacts keeps amounts and obligations, drops labelled inferences and questions', () => {
  assert.deepEqual(selectFacts(REPLY), ['五種協議各自要另外繳月費。', '500U 是整套方案的月費。']);
});

test('selectFacts ignores code blocks and dedupes', () => {
  assert.deepEqual(selectFacts('```\n每月 10 USD\n```\n費用必須先付。\n費用必須先付。'), ['費用必須先付。']);
});

test('selectFacts respects a zero limit and splits on Chinese question marks', () => {
  assert.deepEqual(selectFacts(REPLY, { max: 0 }), []);
  assert.deepEqual(selectFacts('官方收費嗎？費用是 20 元。'), ['費用是 20 元。']);
});

test('quoted punctuation does not split factual sentences', () => {
  const title = '《你今天快樂嗎？》於2020年出版。';
  assert.deepEqual(sentences(title), [title]);
  for (const quote of ['「費用必須先付嗎？」', '『費用必須先付嗎？』', '《費用必須先付嗎？》', '"費用必須先付嗎？"']) {
    const claim = `官方說${quote}後來才更正。`;
    assert.deepEqual(selectFacts(`${claim}費用是 20 元。`), [claim, '費用是 20 元。']);
  }
  const nested = '官方說「書名是《費用必須先付嗎？》；已經出版。」後來才更正。';
  assert.deepEqual(selectFacts(nested), ['官方說「書名是《費用必須先付嗎？》；已經出版。」']);
});

test('a quote ending in a full stop ends the sentence after the closing quote', () => {
  const claim = '他說「價格是100元。」';
  assert.deepEqual(sentences(`${claim}但可能會漲。`), [claim, '但可能會漲。']);
  assert.deepEqual(selectFacts(`${claim}但可能會漲。`), [claim]);
});

test('fact checking keeps factual sentences and leaves speculation in the same quote unchecked', async () => {
  const seen = [];
  const claim = '官方說「費用是20元。」';
  const result = await checkFacts({
    text: '官方說「費用是20元。可能會調整。」',
    evidence: '費用是20元。',
    verify: async ({ claims }) => {
      seen.push(...claims);
      return { claims: [{ verdict: 'supported', gate: 'auto' }] };
    },
  });
  assert.deepEqual(seen.map((s) => s.split(' [source-level claim:')[0]), [claim]);
  assert.deepEqual(result.claims, [claim]);
  assert.deepEqual(selectFacts('官方說「費用可能會調整。月費是20元。年費是200元。」'), [
    '官方說「月費是20元。」', '官方說「年費是200元。」',
  ]);
});

test('qualifiers after a quote apply to all sentences in it', async () => {
  for (const text of ['「月費是20元。年費是200元」均未驗證。', '「月費是20元。年費是200元。」均未驗證。']) {
    assert.deepEqual(sentences(text), [text]);
    const result = await checkFacts({
      text,
      evidence: '費用表',
      verify: async () => assert.fail('qualified quotes must not reach the verifier'),
    });
    assert.deepEqual(result.claims, []);
    assert.equal(result.skipped, 'no_claim');
    assert.deepEqual(selectFacts(`${text}費用必須先付。`), ['費用必須先付。']);
  }
});

test('denials and questions after a quote apply to every sentence in it', () => {
  for (const quote of ['「月費是20元。年費是200元」', '「月費是20元。年費是200元。」']) {
    const denial = `${quote}都是錯的。`;
    const question = `${quote}嗎？`;
    assert.deepEqual(sentences(denial), [denial]);
    assert.deepEqual(selectFacts(denial), [denial]);
    assert.deepEqual(sentences(question), [question]);
    assert.deepEqual(selectFacts(question), []);
  }
});

test('periods in abbreviations do not split the sentences in an English quote', () => {
  const claim = '"The fee in the U.S. is $5."';
  assert.deepEqual(sentences(claim), [claim]);
  assert.deepEqual(selectFacts(claim), [claim]);
  assert.deepEqual(sentences('"The fee in the U.S. is $5. It includes tax."'), [claim, '"It includes tax."']);
});

test('a run of terminators stays with its sentence and a question remains a question', () => {
  for (const end of ['！？', '？！', '!?']) {
    const question = `需要先付月費${end}`;
    const fact = '費用是20元！！';
    assert.deepEqual(sentences(`！！！！！！${question}${fact}`), [question, fact]);
    assert.deepEqual(selectFacts(`${question}${fact}`), [fact]);
    assert.equal(isFactClaim(`「${question}」`), false);
  }
  assert.deepEqual(sentences('官方說「費用是20元！！年費是200元。」'), [
    '官方說「費用是20元！！」', '官方說「年費是200元。」',
  ]);
});

test('an inch mark does not start an ASCII quote', () => {
  assert.deepEqual(
    sentences('螢幕是 6"。官方說"費用必須先付嗎？"後來才更正。'),
    ['螢幕是 6"。', '官方說"費用必須先付嗎？"後來才更正。'],
  );
  assert.deepEqual(selectFacts('螢幕是 6"。費用是 20 元。'), ['費用是 20 元。']);
});

test('standalone quoted questions are not factual claims', () => {
  for (const question of ['「這要收費嗎？」', '『這要收費嗎？』', '"這要收費嗎？"', '‘這要收費嗎？’']) {
    assert.equal(isFactClaim(question), false);
    assert.deepEqual(selectFacts(question), []);
  }
  assert.deepEqual(selectFacts('「這要收費嗎？」費用是 20 元。'), ['費用是 20 元。']);
});

test('claims can end in a title that contains a question', () => {
  for (const claim of ['手冊包含《需要收費嗎？》', '手冊包含〈需要收費嗎？〉']) {
    assert.equal(isFactClaim(claim), true);
    assert.deepEqual(selectFacts(claim), [claim]);
  }
});

test('a quoted question does not turn an enclosing statement into a question', () => {
  for (const claim of ['手冊包含「需要收費嗎？」', '官方說「費用必須先付嗎？」', '官方說"費用必須先付嗎？"']) {
    assert.equal(isFactClaim(claim), true);
    assert.deepEqual(selectFacts(claim), [claim]);
  }
});

test('no evidence -> every fact is not_addressed without calling the verifier', async () => {
  let called = false;
  const r = await checkFacts({ text: REPLY, evidence: '', verify: async () => { called = true; } });
  assert.equal(called, false);
  assert.deepEqual(r.judged.map((j) => j.verdict), ['not_addressed', 'not_addressed']);
  assert.equal(r.decisive.claim, '五種協議各自要另外繳月費。');
});

test('verifier verdicts map back to the clean claim and the worst one is decisive', async () => {
  const seen = [];
  const verify = async ({ claims, evidence }) => {
    seen.push(...claims);
    assert.match(evidence, /自動選用/);
    return { claims: [{ verdict: 'contradicted', gate: 'auto' }, { verdict: 'supported', gate: 'auto' }] };
  };
  const r = await checkFacts({ text: REPLY, evidence: '系統自動選用合適的協議。帳單：Solution monthly commitment 500U', verify });
  assert.ok(seen.every((c) => c.includes('source-level claim')));
  assert.equal(r.judged[0].claim, '五種協議各自要另外繳月費。');
  assert.equal(r.decisive.verdict, 'contradicted');
});

test('verifier error is reported, never turned into a verdict', async () => {
  const r = await checkFacts({ text: REPLY, evidence: 'x', verify: async () => { throw new Error('boom'); } });
  assert.equal(r.error, 'boom');
  assert.equal(r.decisive, null);
});

test('no fact claim -> skipped', async () => {
  assert.equal((await checkFacts({ text: '今天天氣很好呢。' })).skipped, 'no_claim');
});

test('invalid verifier verdicts return an error without partial judgments', async (t) => {
  const valid = { verdict: 'supported', gate: 'auto' };
  for (const [name, claims, error] of [
    ['missing array', undefined, /exactly 2 verdicts/],
    ['too few', [valid], /exactly 2 verdicts/],
    ['too many', [valid, valid, valid], /exactly 2 verdicts/],
    ['missing verdict', [valid, {}], /missing or unknown verdict for claim 2/],
    ['unknown verdict', [valid, { verdict: 'bogus' }], /missing or unknown verdict for claim 2/],
  ]) {
    await t.test(name, async () => {
      const result = await checkFacts({ text: REPLY, evidence: 'x', verify: async () => ({ claims }) });
      assert.match(result.error, error);
      assert.equal(result.claims.length, 2);
      assert.deepEqual(result.judged, []);
      assert.equal(result.decisive, null);
    });
  }
});

test('decisive ranks confident contradiction over not_addressed', () => {
  const j = [{ verdict: 'not_addressed', gate: 'auto' }, { verdict: 'contradicted', gate: 'review' }, { verdict: 'contradicted', gate: 'auto' }];
  assert.equal(decisive(j), j[2]);
});
