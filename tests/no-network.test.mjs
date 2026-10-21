import test from 'node:test';
import assert from 'node:assert/strict';
import { allowed } from './_no-network.mjs';

// The preload is what keeps `npm test` off real providers; prove it still bites.
test('no-network preload blocks real providers and the live cascade, allows test servers', async () => {
  assert.equal(allowed('https://opencode.ai/zen/v1/systemone'), false);
  assert.equal(allowed('https://openrouter.ai/api/v1/systemone'), false);
  assert.equal(allowed('http://127.0.0.1:8793/v1/systemone'), false, ':8793 is the live cascade → paid OpenRouter');
  assert.equal(allowed('http://127.0.0.1:41234/'), true);
  // Importing allowed() above installs the wrapper too, so check the wiring itself:
  // `npm test` must load the preload for every test file, not just this one.
  assert.match(process.env.NODE_OPTIONS ?? '', /_no-network\.mjs/, 'npm test must preload tests/_no-network.mjs');
  if (process.env.JEV_RUN_SMOKE !== '1') {
    await assert.rejects(fetch('https://openrouter.ai/api/v1/systemone'), /no-network/);
  }
});
