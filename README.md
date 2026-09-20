# Jev Gate MCP

Governed Jev decision gateway for GPT, Claude, and other MCP clients.

Status: product definition complete; implementation not started.

## Documents

- [Product requirements](docs/prd/jev-decision-gateway.md)
- [Domain context](CONTEXT.md)
- [Architecture decisions](docs/adr/0001-governed-two-tool-mcp-boundary.md)

## Product direction

The gateway exposes a small MCP surface for typed Jev judgments while keeping authorization, thresholds, and action execution in deterministic code. It targets local MCP clients through stdio and API-hosted GPT or Claude agents through Streamable HTTP.
