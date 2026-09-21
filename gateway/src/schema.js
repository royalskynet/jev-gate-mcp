// Strict input schemas (Zod v4) for the two public tools.
import { z } from 'zod';
import { LIMITS } from './core.js';

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const jsonValue = z.lazy(() => z.union([jsonPrimitive, z.array(jsonValue), z.record(z.string(), jsonValue)]));
export const JsonSchema = jsonValue;

const rubric = z.union([z.string(), jsonValue, z.null()]);

const choiceQuestion = z.object({
  type: z.literal('choice'),
  instructions: z.union([z.string(), jsonValue]),
  criteria: z.record(z.string(), rubric).refine(
    (c) => {
      const keys = Object.keys(c);
      return keys.length >= 1 && keys.length <= LIMITS.maxChoicesPerQuestion;
    },
    { message: `choice must have 1..${LIMITS.maxChoicesPerQuestion} candidates` },
  ),
});

const scoreQuestion = z.object({
  type: z.literal('score'),
  instructions: z.union([z.string(), jsonValue]),
  criteria: z.array(rubric).min(2),
});

const noulQuestion = z.object({
  type: z.literal('noul'),
  instructions: z.union([z.string(), jsonValue]),
  criteria: z
    .object({ true: rubric.optional(), false: rubric.optional() })
    .optional(),
});

export const QuestionSchema = z.union([choiceQuestion, scoreQuestion, noulQuestion]);

const questionMap = z
  .record(z.string(), QuestionSchema)
  .refine((m) => Object.keys(m).length <= LIMITS.maxQuestions, {
    message: `at most ${LIMITS.maxQuestions} questions`,
  });

export const stateSchema = jsonValue.refine((v) => {
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf8') <= LIMITS.maxStateBytes;
  return Buffer.byteLength(JSON.stringify(v), 'utf8') <= LIMITS.maxStateBytes;
}, { message: 'state exceeds byte limit' });

export const evaluateInputSchema = z
  .object({
    state: stateSchema,
    questions: questionMap,
    model: z.string().max(128).optional(),
  })
  .strict(); // unknown keys rejected: a caller cannot slip in override fields

export const applyPolicyInputSchema = z
  .object({
    policy: z.string().min(1).max(128),
    version: z.union([z.string().max(64), z.number().int().nonnegative()]).optional(),
    state: stateSchema,
    correlation: z
      .object({
        request_id: z.string().max(128).optional(),
        context: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict(); // thresholds/model/composition are server-owned; no per-call override

// --- Output schemas (advertised in tools/list, validates structuredContent) ---
// Every tool result is typed so a client can branch on `outcome`/`error` without
// parsing prose. Errors stay typed and carry no state or secret material.

export const ErrorContentSchema = z.object({
  error: z.object({
    code: z.string(),
    category: z.string(),
    message: z.string(),
  }),
});

const answerSummarySchema = z.object({
  question: z.string(),
  answer: z.any(),
});

const evaluateErrorSchema = z.object({
  question: z.string(),
  code: z.string(),
  message: z.string(),
});

export const EvaluateResultSchema = z.object({
  outcome: z.literal('advisory'),
  model: z.string().nullable(),
  answers: z.array(answerSummarySchema),
  errors: z.array(evaluateErrorSchema),
  coverage: z.enum(['complete', 'incomplete']),
  usage: z.any().nullable(),
  latency_ms: z.number().nullable(),
});

const reasonSchema = z.object({
  question: z.string(),
  confidence: z.number().nullable(),
  semantic_level: z
    .enum(['accept', 'review', 'escalate', 'deny'])
    .nullable(),
  level: z.enum(['accept', 'review', 'escalate', 'deny']).nullable(),
});

export const ApplyPolicyResultSchema = z.object({
  outcome: z.enum(['accept', 'review', 'escalate', 'deny']),
  policy: z.object({ id: z.string(), version: z.number() }),
  mode: z.string(),
  consequence: z.string(),
  // raw composed gate for a shadow/uncalibrated policy whose public outcome was
  // capped at 'review'; observation only, never an authorization. Optional so
  // the stable (non-capped) result shape is unchanged.
  shadow_outcome: z.enum(['accept', 'review', 'escalate', 'deny']).optional(),
  gate_reasons: z.array(reasonSchema),
  coverage: z.enum(['complete', 'incomplete']),
  model: z.string().nullable(),
  answers: z.array(answerSummarySchema).optional(),
  usage: z.any().nullable().optional(),
  latency_ms: z.number().nullable().optional(),
  correlation: z.any().nullable().optional(),
  unavailable: z
    .object({ code: z.string(), message: z.string() })
    .optional(),
});

// A tool either returns its typed result or a typed error; both must validate.
export const EvaluateOutputSchema = z.union([EvaluateResultSchema, ErrorContentSchema]);
export const ApplyPolicyOutputSchema = z.union([ApplyPolicyResultSchema, ErrorContentSchema]);
