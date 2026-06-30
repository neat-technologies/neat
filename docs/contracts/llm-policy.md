---
name: llm-policy
description: "NEAT holds no LLM API key and makes no LLM call on any user-facing or daemon path. Two approved LLM use cases remain, both off the substrate: offline maintainer-reviewed registry refresh, and the user's own agent reasoning over the /neat extend tools. No code shipped to user repos is LLM-authored without explicit user confirmation in the agent session."
governs:
  - "packages/core/**"
  - "packages/mcp/**"
  - "packages/instrumentation-registry/scripts/**"
adr: [ADR-084, ADR-086]
enforcement: [review]
---

# LLM usage policy contract

NEAT's substrate is deterministic, fast, privacy-clean, and reproducible. LLMs operate only where the tradeoffs are positive and never as the author of NEAT's own substrate. This contract reflects ADR-086's correction: the internal post-hoc validator is dropped, and NEAT holds no LLM key.

## 1. NEAT holds no LLM API key

There is no `NEAT_LLM_API_KEY`. No NEAT process — orchestrator, installer, daemon, MCP server — makes an LLM call on behalf of NEAT. The only LLM in the loop is the user's own agent (Claude Code / Codex / Cursor / Windsurf), running under the user's own credentials and session.

## 2. No LLM on any user-facing or daemon path

LLMs are never invoked at `neat init` / `neat sync` time as a code generator, never on the daemon hot path (ingest, attribution, traversal, divergence, staleness), and never on user application code. The substrate's behavior is a pure function of its inputs.

## 3. Two approved LLM use cases, both off the substrate

1. **Offline registry refresh.** The monthly batch job updating `@neat.is/instrumentation-registry` queries an LLM with public package + version metadata. A maintainer reviews and accepts every proposed entry before publish. The LLM sees public metadata only — never user code.
2. **Agent reasoning over the extend tools.** Inside the user's already-trusted agent session, the agent's own model reasons about novel libraries and proposes instrumentation. The user confirms via `neat_dry_run_extension` before any write. NEAT exposes data + write primitives; it supplies no model.

## 4. No LLM-authored code reaches a user repo without confirmation

Any instrumentation the agent proposes for a registry-miss is shown to the user as a diff via `neat_dry_run_extension` and written only on explicit accept. Registry-hit applies are deterministic (no LLM involved). The post-hoc validation a built-in validator would have done is performed by the agent reading `neat_describe_project_instrumentation` after an apply (ADR-086 §3).
