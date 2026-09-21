#!/usr/bin/env node
// Tool-selection eval (item 7): do GPT and Claude know WHEN to call the two
// gateway tools? Uses companion-agent-style prompts; positive cases (a call is
// appropriate) must select jev_evaluate / jev_apply_policy, and negative cases
// (generation / arithmetic / date / ordinary chat) must NOT call any tool.
//
// The dataset and config are validated OFFLINE (no keys). The live part is
// explicitly opt-in (JEV_RUN_EVAL=1 + an OpenRouter key): it asks each model
// via OpenRouter chat-completions for a single-token tool decision and computes
// >=95% correct selection. This is an agent-instruction eval, not a Jev
// judgment — it deliberately uses chat completions, which the gateway itself
// never does for its own decisions.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VALID_EXPECT = new Set(['jev_evaluate', 'jev_apply_policy', 'none']);

/** Offline validation of the eval config/dataset (tested without any key). */
export function validateEvalConfig(dataset) {
  const errors = [];
  if (!Array.isArray(dataset) || dataset.length === 0) {
    return { ok: false, errors: ['dataset must be a non-empty array'] };
  }
  const seen = new Set();
  let positive = 0, negative = 0;
  for (const [i, c] of dataset.entries()) {
    if (!c || typeof c.id !== 'string' || !c.id) errors.push(`case[${i}]: id required`);
    if (seen.has(c.id)) errors.push(`case[${i}]: duplicate id ${c.id}`);
    seen.add(c.id);
    if (typeof c.prompt !== 'string' || !c.prompt.trim()) errors.push(`case[${i}]: prompt required`);
    if (typeof c.expect !== 'string' || !VALID_EXPECT.has(c.expect)) {
      errors.push(`case[${i}]: expect must be one of ${[...VALID_EXPECT].join(', ')}`);
    } else if (c.expect === 'none') negative++; else positive++;
  }
  if (positive === 0) errors.push('dataset must include at least one positive (should-call) case');
  if (negative === 0) errors.push('dataset must include at least one negative (should-not-call) case');
  return { ok: errors.length === 0, errors, positive, negative };
}

const SYSTEM = [
  'You are the routing agent for the Jev Decision Gateway. Each request below is',
  'the next thing to handle; decide whether to call one of the two gateway tools.',
  'jev_evaluate: the caller wants an ADVISORY batch judgment (Choice/Score/Noul)',
  '   over content they supply (score relevance, choose best candidate, flag',
  '   suspicious agent-directed instructions). It never authorizes an action.',
  'jev_apply_policy: the caller wants a GOVERNED server-owned POLICY decision',
  '   (risk-screening an action, verifying completion claims, intent routing),',
  '   returning accept/review/escalate/deny.',
  'Answer with EXACTLY ONE token: jev_evaluate, jev_apply_policy, or none.',
  'Do NOT call a tool for generation, arithmetic, counting, date comparison, or ordinary conversation.',
].join('\n');

export function buildDataset() {
  return [
    { id: 'pos-evaluate-score', prompt: 'The caller asks for an advisory 0-2 relevance score of this fetched article against my query.', expect: 'jev_evaluate' },
    { id: 'pos-evaluate-choice', prompt: 'The caller asks me to choose the single best candidate answer (a Choice judgment) among the supplied options.', expect: 'jev_evaluate' },
    { id: 'pos-evaluate-noul', prompt: 'The caller asks for an advisory judgment of whether this fetched content contains a suspicious instruction aimed at an automated agent.', expect: 'jev_evaluate' },
    { id: 'pos-policy-risk', prompt: 'The caller asks to screen this proposed shell command through the proposed-action-risk governed policy (safe to run or does it need review).', expect: 'jev_apply_policy' },
    { id: 'pos-policy-claims', prompt: 'The caller asks to verify these completion claims against the supplied test evidence through the governed completion-claims policy.', expect: 'jev_apply_policy' },
    { id: 'pos-policy-route', prompt: 'The caller asks to route this task to the correct handler through the governed intent-routing policy.', expect: 'jev_apply_policy' },
    { id: 'neg-chat', prompt: 'Hello, can you chat with me about my weekend plans?', expect: 'none' },
    { id: 'neg-gen', prompt: 'Write me a short poem about the ocean.', expect: 'none' },
    { id: 'neg-arithmetic', prompt: 'What is 137 * 42?', expect: 'none' },
    { id: 'neg-date', prompt: 'Is 2026-09-21 a Monday?', expect: 'none' },
    { id: 'neg-count', prompt: 'How many letters are in the word elephant?', expect: 'none' },
    { id: 'neg-explain', prompt: 'Explain how DNS works in a paragraph.', expect: 'none' },
  ];
}

async function classifyViaOpenRouter({ model, prompt, apiKey, base }) {
  // base already ends in /api (canonical OpenRouter base); append only /v1/...,
  // otherwise we'd double it (the /api/api/... 404 this script used to hit).
  const url = `${base}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], max_tokens: 8 }),
  });
  if (!res.ok) throw new Error(`chat completions ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = (body?.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
  const found = [...VALID_EXPECT].find((t) => text.includes(t));
  return { tool: found ?? null, raw: text };
}

/**
 * Live (opt-in) tool-selection run.
 * @param {string[]} models e.g. ['openai/gpt-5.4-mini','anthropic/claude-haiku-4.5']
 * @param {string} apiKey OpenRouter key (gateway already owns this)
 * @param {string} base OpenRouter base (default https://openrouter.ai/api; ends in /api)
 */
export async function runToolEval({ models, apiKey, base = 'https://openrouter.ai/api', dataset = buildDataset() }) {
  const cfg = validateEvalConfig(dataset);
  if (!cfg.ok) throw new Error('invalid dataset: ' + cfg.errors.join('; '));
  const perModel = [];
  for (const model of models) {
    let correct = 0, posCorrect = 0, posTotal = 0, negCorrect = 0, negTotal = 0;
    const errors = [];
    for (const c of dataset) {
      try {
        const { tool } = await classifyViaOpenRouter({ model, prompt: c.prompt, apiKey, base });
        const hit = (tool ?? 'none') === c.expect;
        correct += hit ? 1 : 0;
        if (c.expect === 'none') { negTotal++; negCorrect += hit ? 1 : 0; }
        else { posTotal++; posCorrect += hit ? 1 : 0; }
      } catch (e) {
        errors.push({ id: c.id, error: e.message });
      }
    }
    perModel.push({
      model,
      accuracy: dataset.length ? correct / dataset.length : 0,
      positive_accuracy: posTotal ? posCorrect / posTotal : 0,
      negative_accuracy: negTotal ? negCorrect / negTotal : 0,
      correct,
      total: dataset.length,
      call_errors: errors,
    });
  }
  const pass = perModel.every((m) => m.accuracy >= 0.95);
  return { pass, threshold: 0.95, per_model: perModel };
}

// CLI entry: offline validation by default; live only with JEV_RUN_EVAL=1.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const dataset = buildDataset();
  const cfg = validateEvalConfig(dataset);
  const optIn = process.env.JEV_RUN_EVAL === '1';
  if (!optIn) {
    process.stdout.write(JSON.stringify({ mode: 'offline-config-validation', ok: cfg.ok, errors: cfg.errors, positive: cfg.positive, negative: cfg.negative }, null, 2) + '\n');
    process.exit(cfg.ok ? 0 : 1);
  }
  const keyFile = process.env.JEV_API_KEY_FILE ?? path.join(os.homedir(), '.creds', 'kv', 'OPENROUTER_API_KEY.txt');
  let apiKey;
  try { apiKey = readFileSync(keyFile, 'utf8').trim(); } catch { apiKey = null; }
  if (!apiKey) { process.stderr.write('tool-eval live: no OpenRouter key; run offline only\n'); process.exit(2); }
  const models = (process.env.JEV_EVAL_MODELS ?? 'openai/gpt-5.4-mini,anthropic/claude-haiku-4.5').split(',').map((s) => s.trim()).filter(Boolean);
  const report = await runToolEval({ models, apiKey });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.pass ? 0 : 1);
}
