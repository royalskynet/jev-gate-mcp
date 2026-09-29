// Private, unlabelled classification examples. Never telemetry, never an
// automatic training feed. A Jev fallback is a teacher suggestion, not gold.
import { appendFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function recordRoutingSample(sample, file = process.env.JEV_ROUTING_LOG
  ?? join(homedir(), '.jevgate', 'routing-samples.jsonl')) {
  if (!file || file === 'off') return false;
  if ([sample.local_model, sample.teacher_model].some(m => /^(fake|mock)(\/|$)/.test(m ?? ''))) return false;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file)) chmodSync(file, 0o600);
    const question_digest = createHash('sha256').update(JSON.stringify(sample.question)).digest('hex');
    appendFileSync(file, JSON.stringify({ ...sample, id: randomUUID(), ts: new Date().toISOString(),
      schema_version: 1, question_digest, label: null, label_source: null,
      split: 'unassigned', training_eligible: false }) + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}
