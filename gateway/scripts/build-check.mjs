// Offline build check: imports every module (catches syntax/import errors),
// loads and validates the policy registry, and boots a fake gateway end to end.
import { loadRegistry } from '../src/registry.js';
import { makeFakeAdapter, FakeMode } from '../src/adapters.js';
import { JevGateway } from '../src/gateway.js';
import { buildServer } from '../src/server.js';
import { buildGateway } from '../src/config.js';
import { resetRuntime } from '../src/core.js';

resetRuntime();
const registry = loadRegistry();
if (registry.ids().length < 4) throw new Error('expected the four starter policy packs, registry missing ' + registry.ids().length);

const g = new JevGateway({ evaluateAdapter: makeFakeAdapter(FakeMode.SUCCESS), registry });
const r = await g.applyPolicy({ policy: 'completion-claims', state: 'evidence present' });
if (r.outcome !== 'accept') throw new Error('fake policy did not accept: ' + r.outcome);

// Build the transport-agnostic server object (confirms tool registration).
buildServer(g);

// config.buildGateway with the fake provider validates the full wiring path.
const { gateway } = buildGateway({ provider: 'fake' });
if (!gateway) throw new Error('buildGateway returned no gateway');

process.stdout.write('build-check OK: ' + registry.ids().join(',') + '\n');