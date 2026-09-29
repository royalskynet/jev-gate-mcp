# Jev Gate

[繁體中文](README.md) · **English**

**Help your AI assistant read less noise and handle simple classifications locally.**

Coding assistants often receive long logs, search results, and tool output.
Jev Gate judges which parts matter to the current task, so less unrelated text
reaches the conversation. It also provides task classification and review
advice for Claude Code and Codex.

## What does it do?

| Situation | What Jev Gate does |
|---|---|
| A tool returns a wall of logs | Keeps relevant passages and removes noise where the host supports it |
| A conversation grows long | Shortens tool records where supported, keeping retained text verbatim |
| You need to assign work or check completion | Offers classification and review advice; completion still requires execution evidence |

For example, a tool might return hundreds of repeated messages while you are
looking for one error. Jev Gate aims to retain the useful clues and reduce the
repetition. It can make mistakes, so its judgments cannot authorize actions.

## How do LAYA and JEV work together?

LAYA is a small model running on your computer. JEV is a cloud judgment service.
With `JEV_PROVIDER=laya`, they share the work:

| Work | Provider |
|---|---|
| Short classifications that match approved schemas, such as task type or message topic | LAYA first |
| Difficulty, risk, completion checks, and other judgments | JEV |
| Local errors, invalid answers, or no matching classification | JEV takes over |

**LAYA is a limited pilot.** It can still misclassify a topic. Log pruning and
conversation compaction continue to use JEV.

A successful local-only classification avoids a cloud request. Mixed tasks can
still need JEV; overall savings have not yet been measured.

## Before you start

- **Cost:** local classification has no cloud fee, but JEV calls may cost money. This is not an entirely free mode.
- **Hardware:** the current local model takes about 540 MB on disk. Loading it has used about 1.2–1.9 GB of memory in measurements.
- **Data:** local classification text and answers are saved by default for later human review. There is no automatic training. Set `JEV_ROUTING_LOG=off` to stop collection.

## Get started

You need Node.js 22 or 24 and a configured JEV credential. To use LAYA, you also
need a local model bundle. The application does not download weights for you.

```sh
git clone https://github.com/royalskynet/jev-gate-mcp.git
cd jev-gate-mcp
npm install
```

Then connect your assistant:

- **Claude Code:** follow the [MCP setup](gateway/README.md#claude-code). For pruning and compaction, also follow the [plugin setup](docs/REFERENCE.en.md#install).
- **Codex:** follow the [Codex setup](gateway/README.md#codex). Host capabilities differ from Claude Code.
- **Already installed:** update the checkout or plugin your host actually uses, then restart its MCP process or session. MCP is the bridge that lets the assistant access these tools.

See [routing and configuration](docs/REFERENCE.en.md#laya-routing)
for LAYA settings and data collection details.

## More information

| Looking for | Read |
|---|---|
| Host capabilities and setup | [Connection guide, Traditional Chinese](docs/zh-TW/README.md) |
| Model routing, saved data, advanced settings | [Technical reference](docs/REFERENCE.en.md) |
| MCP interfaces and development | [Gateway documentation](gateway/README.md) |
| Test results and implementation history | [Development log, Traditional Chinese](docs/DEVLOG.md) |
| Bug reports and progress | [GitHub Issues](https://github.com/royalskynet/jev-gate-mcp/issues) |

The remaining local-model quality limitations are tracked in [Issue #10](https://github.com/royalskynet/jev-gate-mcp/issues/10).
