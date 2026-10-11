import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSkillDoc, describeCandidates, catalogDirs, resetCatalog } from '../../agent-glue/src/catalog.js';

async function skillTree() {
  const root = await mkdtemp(join(tmpdir(), 'jev-catalog-'));
  const write = async (rel, body) => {
    await mkdir(join(root, rel), { recursive: true });
    await writeFile(join(root, rel, 'SKILL.md'), body);
  };
  await write('diagnose', '---\nname: diagnose\ndescription: Rigorous diagnosis loop for hard-to-reproduce bugs.\n---\n\nbody\n');
  await write('deep/skills/deep', '---\nname: deep\ndescription: "Hand the task to a background worker."\n---\n');
  return root;
}

test('catalog: the description comes out of the frontmatter, quoted or not', () => {
  assert.equal(describeSkillDoc('---\ndescription: plain text\n---\n'), 'plain text');
  assert.equal(describeSkillDoc('---\ndescription: "quoted text"\n---\n'), 'quoted text');
  assert.equal(describeSkillDoc('---\nname: x\n---\n'), null, 'no description key');
  assert.equal(describeSkillDoc('no frontmatter at all'), null);
  assert.equal(describeSkillDoc(''), null);
  assert.equal(describeSkillDoc(null), null);
});

test('catalog: candidate ids are filled from SKILL.md, directly and under a plugin root', async () => {
  resetCatalog();
  const root = await skillTree();
  const d = await describeCandidates(['diagnose', 'deep', 'not-a-skill'], { dirs: [root] });
  assert.equal(d.diagnose, 'Rigorous diagnosis loop for hard-to-reproduce bugs.');
  assert.equal(d.deep, 'Hand the task to a background worker.', 'found under <plugin>/skills/<id>');
  assert.equal('not-a-skill' in d, false, 'an id with no doc stays a bare label');
});

test('catalog: an explicit description always wins over the disk', async () => {
  resetCatalog();
  const root = await skillTree();
  const d = await describeCandidates(['diagnose'], { dirs: [root], known: { diagnose: 'caller says so' } });
  assert.equal(d.diagnose, 'caller says so');
});

// Fail-soft: route must keep working when nothing on disk matches, which means
// `null` — the same value a caller passes to force bare labels.
test('catalog: nothing found and nothing asked both answer null', async () => {
  resetCatalog();
  assert.equal(await describeCandidates([]), null);
  assert.equal(await describeCandidates(null), null);
  assert.equal(await describeCandidates(['nope'], { dirs: [join(tmpdir(), 'jev-catalog-missing')] }), null);
});

test('catalog: the search path is overridable and defaults to the skill dirs', () => {
  assert.deepEqual(catalogDirs({ JEV_ROUTE_CATALOG_DIRS: '/a:/b' }), ['/a', '/b']);
  const dirs = catalogDirs({}, '/home/u', '/repo');
  assert.ok(dirs.includes('/repo/skills'));
  assert.ok(dirs.includes('/home/u/.claude/skills'));
  assert.ok(dirs.includes('/home/u/.claude/plugins'));
});
