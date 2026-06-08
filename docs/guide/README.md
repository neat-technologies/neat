# NEAT user guide

NEAT builds a live graph of your system from your source code and your production traces at once, and shows you where the two disagree. This guide takes you from nothing to asking the graph real questions — on the command line and through an AI agent.

Read it in order:

1. **[Getting started](./getting-started.md)** — from nothing to your first divergence in about five minutes. One command, run your app, see where code and reality part ways.
2. **[Core concepts](./concepts.md)** — the four ideas the whole model rests on: the graph, provenance, divergence, and the file as the unit.
3. **[Querying the graph](./querying.md)** — every CLI query verb as a reference, each with a real example and the answer it returns.
4. **[Using NEAT with an AI agent](./ai-agents.md)** — wire the graph into Claude Code (or any MCP client) and let the agent walk it for you, with provenance attached to every answer.
5. **[Troubleshooting](./troubleshooting.md)** — the real failure modes — no observed edges, daemon won't start, stale locks — with cause and fix.

For the REST and MCP surface in full detail, see the [API reference](../api-reference.md). For how confidence travels along a path, see [PROVENANCE.md](../../PROVENANCE.md).
