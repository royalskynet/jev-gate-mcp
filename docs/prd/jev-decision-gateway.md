# PRD: Jev Decision Gateway MCP MVP

- Status: Proposed; ready for triage
- Date: 2026-09-20
- Repository visibility: Private
- Target users: Agent developers, application developers, platform engineers, security reviewers, and operators using GPT or Claude

## Problem Statement

Developers use GPT and Claude for planning, generation, and tool execution, but many recurring agent decisions are narrow semantic judgments: selecting a known route, classifying content, ranking supplied candidates, deciding whether evidence supports a claim, or determining whether a proposed action requires review. Calling a frontier generative model for every such decision is slow, expensive, difficult to calibrate, and often returns prose that must be parsed.

TypeSafe Jev returns constrained Choice, Score, and Noul judgments with probabilities, making it suitable for these bounded decisions. Current Jev integrations, however, fragment into two unsatisfactory shapes. Minimal wrappers expose the raw API but lack policy governance, lifecycle enforcement, and remote MCP support. Rich integrations expose many overlapping domain tools, increasing selection ambiguity and coupling the server to individual workflows. Some projects describe MCP availability as automatic gating even though an agent can decline to call an MCP tool.

Teams need one small, shared gateway that GPT and Claude can call locally or through hosted APIs; that separates agent-defined advisory judgments from server-owned operational policy; and that fails safely when evidence, confidence, or provider availability is insufficient.

## Solution

Build Jev Decision Gateway, a governed MCP service with two tools, two transports, and versioned Decision Policies.

`jev_evaluate` provides advisory, caller-defined batched judgments. `jev_apply_policy` runs server-owned Decision Policies whose questions, pinned model, thresholds, and composition rules cannot be weakened by the calling agent. Both tools return validated typed answers, resolved model identity, usage, latency, coverage, and a deterministic Gate.

The gateway serves local MCP clients through stdio and hosted GPT or Claude agents through Streamable HTTP. Provider Adapters support the native TypeSafe System One API and OpenRouter Decisions API without translating through chat completions. A companion agent skill teaches models when to call the tools. A Host Adapter contract lets applications enforce calls at lifecycle boundaries where model-selected invocation is insufficient.

The MVP does not execute actions, authorize users, inspect arbitrary files, control browsers, or replace deterministic computation. It supplies semantic judgment to code that owns the workflow.

## Goals

1. Give GPT and Claude one stable MCP contract for Jev judgments.
2. Keep the tool catalog small while allowing new use cases through Policy Packs.
3. Make advisory and governed decisions visibly different.
4. Support both model-selected and host-enforced invocation without claiming they are equivalent.
5. Preserve full probability data and expose uncertainty instead of forcing a decision.
6. Ensure incomplete, malformed, unavailable, or uncalibrated results cannot silently authorize consequential actions.
7. Make policy behavior testable, versioned, observable, and reversible.

## Success Metrics

- The same conformance suite passes over stdio and Streamable HTTP with equivalent structured results.
- GPT and Claude select the correct tool in at least 95% of representative tool-selection eval cases where a call is appropriate, while avoiding calls for generation, arithmetic, or ordinary one-off conversation.
- Every accepted answer is validated against the submitted question schema and candidate set.
- No policy returns `accept` when coverage is incomplete, input was truncated, the response is malformed, the provider failed, or the result falls outside calibrated limits.
- No default Policy Pack can automatically authorize an irreversible or externally consequential action.
- Gateway processing overhead, excluding provider latency, remains below 50 milliseconds at p95 for ordinary requests.
- Logs contain no API key or state payload under default configuration.
- Every production policy records a pinned model, policy version, evaluation dataset version, and calibration status.

## Users

- **Agent developer** — Connects the gateway to a GPT or Claude agent and wants predictable typed decisions.
- **Application developer** — Embeds repeatable semantic decisions into a product workflow.
- **Platform engineer** — Deploys and operates one gateway for multiple agent clients.
- **Policy owner** — Defines the questions, thresholds, and consequence rules for a domain decision.
- **Security reviewer** — Verifies the gateway cannot bypass authorization or leak sensitive state.
- **Operator** — Observes latency, cost, errors, decisions, and model or policy drift.

## User Stories

1. As an agent developer, I want one MCP server to work with GPT and Claude, so that I do not maintain vendor-specific decision tools.
2. As an agent developer, I want local stdio support, so that Codex, Claude Code, Claude Desktop, Cursor, and similar clients can launch the gateway.
3. As an agent developer, I want Streamable HTTP support, so that hosted OpenAI and Anthropic APIs can reach the same tools.
4. As an agent developer, I want concise tool descriptions and a companion skill, so that models know when Jev is appropriate.
5. As an agent developer, I want the model to avoid Jev for generation, arithmetic, counting, and date comparison, so that unsuitable calls do not look authoritative.
6. As an agent developer, I want multiple questions evaluated over one state in one request, so that related judgments share input efficiently.
7. As an agent developer, I want Choice, Score, and Noul in the same batch, so that a workflow can obtain all independent signals together.
8. As an agent developer, I want full probability distributions, so that application logic is not limited to the winning label.
9. As an agent developer, I want every response to include the resolved model version, so that alias movement cannot silently hide drift.
10. As an agent developer, I want a no-match outcome for open-world choices, so that Jev is not forced to select an invalid candidate.
11. As an agent developer, I want malformed or incomplete responses returned as typed errors, so that missing answers never look like negative evidence.
12. As an agent developer, I want advisory evaluations clearly marked, so that an agent-defined question cannot become permission to perform a consequential action.
13. As an application developer, I want a named, versioned Decision Policy, so that production behavior is reviewable and repeatable.
14. As an application developer, I want to supply runtime state without supplying thresholds, so that untrusted callers cannot weaken policy.
15. As an application developer, I want a deterministic Gate result, so that ordinary code can branch on `accept`, `review`, `escalate`, or `deny`.
16. As an application developer, I want Gate reasons tied to individual signals, so that a reviewer can understand why automation stopped.
17. As an application developer, I want incomplete coverage to prevent acceptance, so that truncated evidence cannot approve a decision.
18. As an application developer, I want provider failures to return unavailable rather than fabricated judgments, so that fallback is explicit.
19. As an application developer, I want to choose native TypeSafe or OpenRouter without changing policy contracts, so that procurement and routing remain flexible.
20. As an application developer, I want the host to own generative-model fallback, so that Jev failure does not silently change model semantics.
21. As an application developer, I want prepared action candidates validated before Jev selection, so that Jev cannot invent tool names or arguments.
22. As an application developer, I want authorization and prerequisites checked in code, so that semantic confidence is never mistaken for permission.
23. As an application developer, I want retry counts and numeric limits computed in code, so that Jev is not asked to perform unreliable arithmetic.
24. As a policy owner, I want policy questions, thresholds, model versions, and composition rules stored together, so that reviews cover the complete behavior.
25. As a policy owner, I want policy versions to be immutable after release, so that historical decisions remain reproducible.
26. As a policy owner, I want new model versions evaluated in shadow mode, so that calibration changes are visible before activation.
27. As a policy owner, I want thresholds tuned against labeled target-domain data, so that confidence is not treated as universal accuracy.
28. As a policy owner, I want separate policies for read-only, reversible, external, and irreversible consequences, so that risk tolerance reflects impact.
29. As a policy owner, I want a Policy Pack for intent routing, so that incoming tasks can select among known handlers or escalate.
30. As a policy owner, I want a Policy Pack for context screening, so that fetched content can be assessed for relevance and suspicious instructions before use.
31. As a policy owner, I want context screening to remain advisory, so that Jev is not represented as an injection-proof security system.
32. As a policy owner, I want a Policy Pack for proposed-action risk, so that outward-facing, destructive, credential-related, or out-of-scope actions receive review.
33. As a policy owner, I want a Policy Pack for completion claims, so that an agent cannot claim tests passed or work completed without supplied evidence.
34. As a platform engineer, I want API keys stored only in server configuration, so that agents never pass credentials as tool arguments.
35. As a platform engineer, I want configurable timeouts, bounded retries, and a circuit breaker, so that provider instability does not stall agents indefinitely.
36. As a platform engineer, I want strict request-size and question-count limits, so that one caller cannot create uncontrolled cost or latency.
37. As a platform engineer, I want oversized requests rejected rather than silently truncated, so that the meaning of a decision never changes invisibly.
38. As a platform engineer, I want a kill switch, so that Jev can be bypassed immediately during an incident.
39. As a platform engineer, I want a health endpoint for remote deployments and a diagnostic command for local deployments, so that connectivity and credentials can be verified safely.
40. As an operator, I want latency, usage, provider, policy version, Gate result, and error class recorded, so that cost and reliability can be monitored.
41. As an operator, I want state logging disabled by default, so that sensitive content is not retained accidentally.
42. As an operator, I want shadow outcomes and later human outcomes linkable by opaque identifiers, so that calibration can improve without storing raw state.
43. As an operator, I want model and policy drift reports, so that changed probability distributions trigger review.
44. As a security reviewer, I want the gateway to expose no file, shell, browser, or arbitrary network execution capability, so that its core attack surface stays narrow.
45. As a security reviewer, I want external state treated as untrusted data, so that instructions embedded in state do not gain authority.
46. As a security reviewer, I want irreversible actions to require an independent approval path, so that Jev cannot become the sole authorization boundary.
47. As a security reviewer, I want secrets and credential-like fields rejected or redacted according to deployment policy, so that state cannot accidentally exfiltrate credentials.
48. As a test engineer, I want Provider Adapters exercised against deterministic fakes, so that failures and malformed responses are reproducible without API cost.
49. As a test engineer, I want opt-in live smoke tests, so that real TypeSafe and OpenRouter compatibility can be checked without making ordinary CI depend on external services.
50. As a maintainer, I want domain features added as policies rather than new MCP tools, so that the public tool surface remains stable.

## Functional Requirements

### MCP surface

- Expose exactly two MVP tools: `jev_evaluate` and `jev_apply_policy`.
- Publish strict input and output schemas as MCP structured content.
- Return the same successful and error shapes across both transports.
- Include a server capability description explaining that Jev judges supplied state but does not generate or execute.

### Advisory evaluation

- Accept string, object, or array state subject to configured limits.
- Accept multiple independent Choice, Score, and Noul questions.
- Validate Choice cardinality and candidate identity, Score level count and ordering, and Noul criteria shape.
- Require callers to declare whether a Choice is closed-world; supply a reportable no-match candidate for open-world choices.
- Return raw answers plus deterministic interpretation metadata.
- Mark every result as advisory and incapable of authorizing consequential action.

### Governed policies

- Resolve an immutable policy by stable identifier and version.
- Load policy-owned questions, model version, thresholds, consequence class, coverage requirements, and Gate composition.
- Permit runtime state and non-authoritative correlation metadata only.
- Reject per-call attempts to override policy thresholds, model, or composition.
- Return Gate reasons and the policy version used.
- Provide shadow and active modes per policy.

### Starter Policy Packs

- **Intent routing** — Select a known handler, skill, or model tier with an explicit no-match or human-review route.
- **Context screening** — Judge relevance, substantive content, suspicious agent-directed instructions, and contradiction signals; remain advisory.
- **Proposed-action risk** — Assess destructive effect, external effect, credential exposure, scope, and blast radius; default to review or denial for consequential actions.
- **Completion claims** — Compare explicit claims with supplied diff, test, log, or document evidence; incomplete or unsupported claims prevent acceptance.

### Automatic invocation

- Ship companion agent instructions defining when to answer normally, when to call the MCP tool, and when production code should call the gateway directly.
- Describe Agent-selected invocation as best-effort and observable, never mandatory.
- Define a Host Adapter lifecycle contract for before-action, after-external-result, and before-finish boundaries.
- Require hosts to honor non-accepting Gate results rather than treating them as suggestions.
- Keep concrete vendor hooks outside the core runtime so that GPT and Claude integrations share policy behavior.

### Providers

- Support the native TypeSafe System One endpoint and OpenRouter Decisions endpoint.
- Keep provider-specific model identifiers and request shapes inside Provider Adapters.
- Never send Jev through chat completions.
- Pin versioned models for active policies and record the resolved model on every result.
- Classify authentication, rate-limit, timeout, transport, provider, malformed-response, and invalid-request failures.

### Operations

- Retry only retryable failures with bounded exponential backoff and provider retry hints.
- Enforce total deadlines and circuit breaking.
- Provide local diagnostics and remote health status without exposing secrets.
- Support immediate global and per-policy kill switches.
- Emit structured telemetry without state payloads by default.

## Automatic Invocation Scenarios

### Agent-selected scenarios

- A request must be routed among known handlers, tools, skills, or model tiers.
- Several semantic questions must be answered over the same supplied evidence.
- A list of already retrieved candidates must be ranked or filtered before entering context.
- Claims must be compared with evidence supplied in the current turn.
- A proposed diff needs fast risk screening before deeper generative review.

These calls are convenient but optional because the model controls tool selection.

### Host-enforced scenarios

- Before a shell command, file mutation, external API call, purchase, publication, or other prepared action crosses an execution boundary.
- After untrusted web, email, user-generated, or third-party MCP content enters the workflow.
- After a failed step when the bounded choices are retry, change approach, gather context, ask the user, or stop.
- Before an agent reports completion or makes claims about tests, deployment, or evidence.

These calls require hooks, middleware, or application workflow code. MCP registration alone does not enforce them.

### Application-driven scenarios

- Batch support-ticket, email, moderation, document, or record routing.
- Confidence-gated extraction after code enumerates candidate source values.
- Retrieval reranking or evidence selection over code-supplied candidates.
- High-volume semantic features used by deterministic downstream logic.

Production application decisions should call the gateway from tested code rather than depend on an agent remembering to call a tool.

## Non-Functional Requirements

### Security and privacy

- API keys never appear in tool arguments, results, ordinary logs, or diagnostics.
- State is not persisted or logged by default.
- The core service reads no arbitrary files, executes no commands, controls no browser, and performs no caller-directed network fetch.
- Remote transport requires authenticated access and deployment-level request limits.
- Consequential decisions require independent authorization outside the gateway.
- Prompt-injection detection is an advisory signal, not a security guarantee.

### Reliability

- Provider errors fail closed with respect to policy acceptance.
- The service never fabricates a result from missing answers.
- Requests are idempotent from the gateway's perspective and receive correlation identifiers.
- Kill switches and provider circuit state take effect without changing policy definitions.

### Performance and cost

- Batch independent questions sharing state into one provider request where supported.
- Reject unbounded candidate lists or split them only through explicit, tested reduction policies.
- Record input token usage, latency, and estimated cost when the provider exposes sufficient data.
- Do not optimize for provider latency at the expense of silent truncation or weakened validation.

### Compatibility

- Support local MCP clients that implement stdio.
- Support hosted clients that implement Streamable HTTP MCP.
- Keep tool names, schemas, and semantic result meanings stable across transports and providers.
- Version policy contracts independently from server releases.

## Implementation Decisions

- Build one application service behind two transport adapters rather than separate local and remote servers.
- Use a deep Gateway Core module that owns canonical request types, limits, answer validation, error classification, and result construction.
- Isolate native TypeSafe and OpenRouter Decisions behavior behind Provider Adapters.
- Isolate `accept`, `review`, `escalate`, and `deny` composition in pure, deterministic Policy Engine functions.
- Store Decision Policies as versioned data validated on startup; released versions are immutable.
- Use a Policy Registry to resolve stable identifiers and expose policy metadata without exposing secret thresholds to untrusted callers where deployment policy forbids it.
- Represent Agent-selected and Enforced invocation as distinct integration modes.
- Define a provider-neutral Host Adapter contract instead of embedding Claude-specific or OpenAI-specific hooks in the core.
- Keep fallback routing outside the gateway. The gateway reports uncertainty or unavailability; the host decides whether to use a generative model or a person.
- Add domain features through Policy Packs before considering new MCP tools.
- Pin `jev-1.13.0` for initial active policies. Model aliases may be available only for experiments and shadow evaluation.
- Use TypeSafe-native semantics for Noul, Choice, and Score. Do not invent a separate confidence field for Noul.
- Interpret Choice and Score confidence as distribution concentration, not factual correctness.
- Keep calculations, date handling, counting, schema checks, authorization, retry counters, and exact thresholds in deterministic code.
- Treat all state as untrusted data and questions or policies as the only instruction authority.

## Testing Decisions

- Test externally visible behavior rather than private implementation details.
- Run the same MCP conformance cases against stdio and Streamable HTTP and compare normalized results.
- Test the Gateway Core with deterministic Provider Adapter fakes covering valid answers, missing answers, foreign choices, wrong probability keys, invalid legends, timeouts, rate limits, and provider failures.
- Test the Policy Engine as pure input-output behavior, including every Gate branch and the invariant that incomplete coverage cannot accept.
- Test that advisory evaluation cannot produce an authorization result.
- Test that callers cannot override governed policy model versions, thresholds, or composition.
- Test version immutability and startup rejection of duplicate or invalid policies.
- Test no-match behavior for open-world Choice questions and exact candidate preservation for closed-world questions.
- Test request limits without silent truncation.
- Test logs and diagnostics for API-key and state leakage using canary secrets.
- Fuzz tool inputs, structured state, question maps, response distributions, and policy metadata.
- Test kill switches, deadlines, retry ceilings, and circuit breaking through observable results.
- Maintain provider contract fixtures for native TypeSafe and OpenRouter Decisions shapes.
- Keep real-provider smoke tests opt-in and secret-gated; ordinary CI must pass offline.
- Build labeled evaluation sets per Policy Pack and report coverage at target precision, false-accept rate, review rate, latency, cost, and drift.
- Evaluate companion skill behavior with representative GPT and Claude prompts, including positive and negative tool-selection cases.
- Do not treat demo data, model confidence, or another repository's thresholds as acceptance evidence for this product.

## Rollout Plan

1. Implement Gateway Core, strict schemas, stdio transport, native TypeSafe adapter, and offline tests.
2. Add Streamable HTTP transport and run cross-transport conformance tests.
3. Add OpenRouter Decisions adapter and opt-in live smoke tests.
4. Add Policy Registry, Policy Engine, shadow mode, kill switches, and structured telemetry.
5. Ship companion agent instructions and tool-selection evals for GPT and Claude.
6. Implement starter Policy Packs and labeled evaluation sets.
7. Run all policies in shadow mode against representative workflows.
8. Activate only policies whose target-domain metrics and consequence rules have been reviewed.

## Risks and Mitigations

- **Agent skips an MCP call.** Use Host Adapters for mandatory boundaries and measure Agent-selected call rates separately.
- **Confidence is mistaken for correctness.** Preserve probabilities, document semantics, and require domain calibration.
- **Model alias changes behavior.** Pin production versions and shadow-test upgrades.
- **Adversarial state steers judgment.** Treat state as data, keep policies precise, test adversarial cases, and never make Jev the sole security boundary.
- **Large irrelevant state reduces quality.** Require targeted state, reject silent truncation, and report incomplete coverage.
- **Provider outage stalls workflows.** Apply deadlines and circuit breaking, then return explicit unavailability for host-controlled fallback.
- **Tool catalog expands uncontrollably.** Require a documented reason a Policy Pack cannot solve the use case before adding a tool.
- **Cross-provider probabilities drift.** Calibrate provider and model combinations independently and record both on results.
- **Sensitive data leaves the host.** Minimize state, redact according to deployment policy, disable payload logging, and document provider data handling.

## Out of Scope

- Free-form text, code, explanation, or plan generation.
- A general-purpose chat model fallback inside the gateway.
- Heuristic scoring presented as calibrated Jev output.
- Browser, desktop, shell, repository, filesystem, database, or arbitrary HTTP execution in the core service.
- Automatic discovery or upload of repository files.
- A universal prompt-injection firewall or security boundary.
- Authentication or authorization of end users and actions.
- Automatic execution of external, destructive, financial, publication, or communication actions.
- Date arithmetic, counting, numeric comparison, schema validation, or other deterministic computation delegated to Jev.
- Fine-tuning Jev or training customer-specific weights.
- More than the two defined MCP tools during MVP.
- Production activation of an uncalibrated Decision Policy.

## Further Notes

### Prior art reviewed

- TypeSafe's official agent skill supplies the authoritative workflow design guidance but no runtime MCP service.
- `itsmostafa/typesafe-mcp` demonstrates a compact single-tool server, static distribution, native TypeSafe and OpenRouter support, and convenient local-client setup.
- `jkudish/jev-mcp` demonstrates useful domain recipes but also the tool-catalog growth the gateway intends to avoid.
- `rashedInt32/jev-mcp` demonstrates no-match handling, strict response validation, and careful file-access boundaries.
- `burnigtm/jev-mcp` demonstrates prepared action selection and explicit coverage, but its coding-loop specialization is not part of the core MVP.
- `Brainwires/jevwire` demonstrates lifecycle hooks, deterministic policy composition, calibration logs, and the critical distinction between an MCP tool and a mandatory harness check.
- `tacticocc/Jevbridge` demonstrates MCP and ACP interoperability, but its heuristic and generative fallbacks are intentionally excluded.
- `browser-use/jev-ultrafast`, Jev Review, and Jev model routers demonstrate valuable vertical applications that should be built above the gateway.

### Product position

Jev Decision Gateway is not another collection of Jev utilities. It is the smallest governed boundary that makes Jev reusable across GPT, Claude, local agents, hosted agents, and application workflows without confusing semantic judgment with authorization or execution.
