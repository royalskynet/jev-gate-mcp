// Test preload (NODE_OPTIONS=--import): a test that reaches a real provider or
// the live cascade (:8793 → paid OpenRouter) fails instead of spending quota.
// 10-18 test traffic fed the Zen abuse flag and Jev's daily budget (fix 10986/10987).
// Tests that stub globalThis.fetch replace this wrapper and are unaffected.
const real = globalThis.fetch;
const LIVE_PORTS = new Set(['8793']);

export function allowed(url) {
  const u = new URL(String(url?.url ?? url));
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  return loopback && !LIVE_PORTS.has(u.port);
}

if (real && process.env.JEV_RUN_SMOKE !== '1') {
  globalThis.fetch = async (url, init) => {
    if (!allowed(url)) throw new Error(`no-network: test tried real fetch ${new URL(String(url?.url ?? url)).origin} (stub fetch, or JEV_RUN_SMOKE=1 for an opt-in live test)`);
    return real(url, init);
  };
}
