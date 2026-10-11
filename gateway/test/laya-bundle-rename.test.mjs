// The community int8 graph exports `act_logits`; receptron reads `act_probs`.
// scripts/fetch-laya-bundle.mjs renames it in place, which means rewriting a
// protobuf string one byte shorter and shrinking every enclosing length varint
// — including the case where a length drops below 128 and the varint itself
// loses a byte. These fixtures pin that arithmetic without a 540MB download.
import test from 'node:test';
import assert from 'node:assert';
import { renameOutput } from '../../scripts/fetch-laya-bundle.mjs';

const varint = (n) => {
  const out = [];
  let v = n;
  do { const b = v % 128; v = Math.floor(v / 128); out.push(b | (v > 0 ? 0x80 : 0)); } while (v > 0);
  return Buffer.from(out);
};
// field number + wire type 2, then the payload behind its length.
const field = (num, payload) => Buffer.concat([varint((num << 3) | 2), varint(payload.length), payload]);
const raw = (s) => Buffer.from(s, 'latin1');

// A miniature ModelProto: graph(7) { node(1) { output(2) }, output(12) { name(1) } }.
const model = (name, fillerBytes) => {
  const node = field(1, Buffer.concat([
    field(1, raw('input')), field(2, raw(name)), field(4, raw('x'.repeat(fillerBytes))),
  ]));
  const valueInfo = field(12, field(1, raw(name)));
  return field(7, Buffer.concat([node, valueInfo]));
};

test('renames both output names and fixes every enclosing length', () => {
  const { buf, renamed } = renameOutput(model('act_logits', 40), 'act_logits', 'act_probs');
  assert.equal(renamed, 2);
  assert.deepEqual(buf, model('act_probs', 40));
});

test('shrinks the length varint when a message drops below 128 bytes', () => {
  // Filler chosen so the node payload is 129 bytes with the long name: removing
  // one byte lands on 128, removing the second on 127 — a two-byte varint
  // becoming one. deepEqual against the independently built target catches it.
  const before = model('act_logits', 110);
  const { buf, renamed } = renameOutput(before, 'act_logits', 'act_probs');
  assert.equal(renamed, 2);
  assert.deepEqual(buf, model('act_probs', 110));
  assert.ok(before.length - buf.length >= 2);
});

test('leaves a graph that already exports act_probs alone', () => {
  const clean = model('act_probs', 10);
  const { buf, renamed } = renameOutput(clean, 'act_logits', 'act_probs');
  assert.equal(renamed, 0);
  assert.deepEqual(buf, clean);
});

test('ignores the name inside embedded source blobs', () => {
  // The real graph carries python tracebacks mentioning `act_logits`; only a
  // length-delimited field whose whole payload is the name may be renamed.
  const doc = field(7, field(9, raw('  act_logits = self.act_head(torch.cat(...))')));
  const { buf, renamed } = renameOutput(doc, 'act_logits', 'act_probs');
  assert.equal(renamed, 0);
  assert.deepEqual(buf, doc);
});
