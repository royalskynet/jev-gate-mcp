# ADR-0001: Governed two-tool MCP boundary

- Status: Accepted
- Date: 2026-09-20

## Context

Existing Jev projects range from a single raw evaluation tool to ten or more domain-specific tools. A raw wrapper is easy to integrate but cannot govern consequential decisions. A large tool catalog offers convenient recipes but increases tool-selection ambiguity, prompt cost, and coupling to individual workflows. MCP also permits an agent to call a tool but does not ensure that a required check occurs.

The product must work with both GPT and Claude, through local agent clients and hosted APIs. It must distinguish advisory semantic judgment from mandatory execution policy.

## Decision

Expose two stable MCP tools:

1. `jev_evaluate` accepts caller-defined atomic Choice, Score, and Noul questions over supplied state. Its result is advisory.
2. `jev_apply_policy` executes a server-owned, versioned Decision Policy. The caller supplies state but cannot modify questions, thresholds, composition rules, or model version.

Support stdio and Streamable HTTP transports over the same application service. Support native TypeSafe and OpenRouter Decisions through Provider Adapters, without substituting heuristic or generative-model probabilities.

Provide companion instructions for Agent-selected invocation. Treat mandatory invocation as a Host Adapter responsibility at lifecycle boundaries such as before an action, after untrusted retrieval, and before completion.

## Consequences

- The MCP surface stays small while new domains arrive as Policy Packs.
- Policy review and calibration are centralized and versioned.
- GPT and Claude share one contract across local and hosted environments.
- A standalone MCP installation offers advisory automation but is not, by itself, a security boundary.
- Host integrations must explicitly honor `review`, `escalate`, and `deny` results.
- Domain-specific file reading, browser control, code review, and model routing remain optional adapters or policies rather than core tools.
