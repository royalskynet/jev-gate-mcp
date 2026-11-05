# factcheck

Pick the fact claims out of an LLM reply and check each one against the evidence the model actually saw.

An agent reads three documents, then answers "each of the five protocols is billed separately". None of the documents says that. The sentence is an inference presented as a fact. This library finds such sentences and asks a verifier two questions per claim:

1. Is there a source passage for it?
2. Does that passage actually state it?

Verdicts: `supported`, `contradicted`, `not_addressed`.

## How it works

1. **Select (deterministic, free).** The reply is split into sentences. A sentence counts as a fact claim when it states an amount, rate, obligation, scope ("includes", "each … separately") or attributes something to a source ("the docs say"). Sentences labelled as inference ("I infer", "possibly", "unverified") and questions are skipped, so an honest label is never punished. Code blocks are ignored.
2. **No evidence, no call.** If the agent saw no evidence at all, every fact claim is `not_addressed` without calling the verifier.
3. **Verify (one request).** All claims go to the verifier in one batch, each tagged as a source-level claim: an inference from nearby passages counts as `not_addressed`.
4. **Decide.** `decisive` returns the one verdict worth acting on: confident contradiction first, then any contradiction, then a confident `not_addressed`.

Verifier errors come back as `error`, never as a verdict.

## Use

```js
import { checkFacts, jevVerifier } from './index.js';
import { JevDecisionModel } from 'jevwire';

const model = new JevDecisionModel({ apiKey: process.env.JEV_API_KEY, baseUrl: process.env.JEV_BASE_URL, model: process.env.JEV_MODEL });

const r = await checkFacts({
  text: replyText,          // what the agent said
  evidence: toolOutputs,    // what the agent actually read (tool results, documents)
  verify: jevVerifier(model),
});
// r.judged   -> [{ claim, verdict, gate, ... }]
// r.decisive -> the worst verdict, or null
```

Any verifier works. It receives `{ claims: string[], evidence: string }` and resolves to `{ claims: [{ verdict, gate }] }` in the same order. `jevwire` is an optional peer dependency used only by `jevVerifier`.

## Limits

- The selector is a keyword heuristic tuned for Traditional Chinese and English. Paraphrased facts without trigger words are missed. Run it in shadow mode (log only) first and measure.
- Evidence is whatever you pass. Knowledge the agent got elsewhere (system prompt, earlier sessions) is not evidence unless you include it, so it reads `not_addressed`.
- This is an after-the-fact check. It flags a reply; it does not stop it from being sent.

## Test

```sh
node --test factcheck.test.mjs
```

MIT
