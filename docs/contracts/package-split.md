---
name: package-split
description: "In the current batch (v0.4.7), only @neat.is/instrumentation-registry splits out as a separately-versioned package; @neat.is/core stays unified. The full core/instrumenter split is deferred (#385), gated on a concrete consumer needing the substrate without the installer. Substrate/installer separation is held by a directory boundary + lint rules until then. The Claude Code plugin at /plugin is a repo-hosted bundle of already-shipped surface, not an npm package."
governs:
  - "packages/core/**"
  - "packages/instrumentation-registry/**"
  - "plugin/**"
  - ".claude-plugin/**"
adr: [ADR-083, ADR-086, ADR-080, ADR-159]
enforcement: [review]
---

# Package split contract

The substrate (receiver + graph + REST + MCP) and the installer (orchestrator + framework templates + registry consumer) change at different rates. The full packaging separation of those concerns is a later step; the current batch makes the one split with a structurally-unique benefit.

## 1. The current batch splits the registry only

`@neat.is/instrumentation-registry` is the only package that splits out in the current batch (v0.4.7, ADR-080). Its independent versioning — registry refreshes shipping without bumping NEAT — is the structural benefit no monorepo boundary can replicate. `@neat.is/core` stays unified: substrate and installer live in one package.

## 2. The full core/instrumenter split is deferred

Splitting `@neat.is/core` (substrate) from `@neat.is/instrumenter` (installer) is deferred (#385). It lands when there is a concrete consumer that needs the substrate without the installer — the hosted-SaaS server tier or a self-instrumenting adopter. Until that consumer exists, the split's other benefits (release cadence, test strategy, structural enforcement) are achievable inside the monorepo.

## 3. The substrate/installer boundary is held by directory + lint, not packaging

While core stays unified, the separation is enforced by a directory boundary (`packages/core/src/installers/**` and orchestrator vs the receiver/graph/REST/MCP modules) plus a lint rule forbidding the substrate modules from importing installer modules. The dependency direction stays acyclic in anticipation of the v0.6 split: installer code may import substrate public surfaces; substrate code may not import installer code.

## 4. When the v0.6 split lands

The dependency direction is `instrumenter → core's public types + CLI/HTTP surface`, no internal-module imports crossing the boundary. The `neat.is` umbrella depends on both at compatible ranges and ships the unified CLI experience. This section is the forward plan; it binds the directory discipline in §3 now so the eventual split is a packaging move, not a refactor.

## 5. The Claude Code plugin is a bundle, not a package (ADR-159)

The Claude Code plugin lives at `/plugin` in the repo root — deliberately outside `packages/`, because it is not an npm package. It carries no build, no `package.json`, and never enters the six-package lockstep or the publish pipeline (`publish-system.md` §"Repo-hosted plugin"). It is a bundle: a Claude-Code plugin layout that repackages surface NEAT already ships à la carte.

What it contains, and where each piece comes from:

- `plugin/.mcp.json` — the NEAT MCP server, mirroring `packages/claude-skill/claude_code_config.json`'s `mcpServers.neat` (stdio, `npx -y @neat.is/mcp`, `NEAT_CORE_URL`). Same server the `neat skill` command wires.
- `plugin/hooks/neat-search-nudge.mjs` — a byte-identical copy of `packages/claude-skill/hooks/neat-search-nudge.mjs`, invoked by `plugin/hooks/hooks.json` via `${CLAUDE_PLUGIN_ROOT}` with the same `Grep|Glob|Bash` matcher `neat hooks` writes (`HOOK_MATCHER`).
- `plugin/skills/graph-first/SKILL.md` — the shipped `packages/claude-skill/SKILL.md` body, with plugin frontmatter (`name: graph-first`) prepended.
- `plugin/.claude-plugin/plugin.json` — the plugin manifest (only this file lives under `.claude-plugin/`; everything else sits at the plugin root, per the Claude Code plugin layout).

The bundle reuses shipped surface rather than forking it. It invents no capability — the à-la-carte `neat skill` / `neat hooks` commands remain the other install path. Because the bundle carries copies, a contract test (`packages/core/test/plugin-packaging.test.ts`) asserts the plugin's `.mcp.json` server equals the shipped `mcpServers.neat` and the hooks matcher equals `HOOK_MATCHER`, and that the bundled hook is byte-identical to the shipped one — so the copies cannot silently diverge from their source of truth.
