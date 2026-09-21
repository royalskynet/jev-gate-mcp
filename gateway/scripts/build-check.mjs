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
// Starter policies are shadow/uncalibrated: the gateway must never auto-accept,
// capping the outcome at 'review' and exposing the raw gate as shadow_outcome.
if (r.outcome !== 'review') throw new Error('shadow/uncalibrated policy must cap at review, got: ' + r.outcome);
if (r.shadow_outcome !== 'accept') throw new Error('expected raw composed gate accept via shadow_outcome, got: ' + r.shadow_outcome);

// Build the transport-agnostic server object (confirms tool registration).
buildServer(g);

// config.buildGateway with the fake provider validates the full wiring path.
const { gateway } = buildGateway({ provider: 'fake' });
if (!gateway) throw new Error('buildGateway returned no gateway');

process.stdout.write('build-check OK: ' + registry.ids().join(',') + '\n');