---
name: init
description: neat init is one-time registration. Discovery before mutation. Patch-by-default; --apply opt-in. Lockfiles never touched. Idempotent. init and install are one command.
governs:
  - "packages/core/src/cli.ts"
  - "packages/core/src/installers/**"
  - "packages/core/src/registry.ts"
adr: [ADR-046, ADR-026, ADR-027]
enforcement: [lint, review]
---

# `neat init` contract

The first of four v0.2.5 distribution-layer contracts. Sibling contracts: [`sdk-install.md`](./sdk-install.md), [`project-registry.md`](./project-registry.md), [`daemon.md`](./daemon.md).

## One-time registration

`neat init <path>` is the install moment. Like `brew install` followed by `claude init`. Re-running is idempotent but the user's mental model is install-once.

## What `init` does, in order

1. **Discover.** Walk `<path>` honoring `.gitignore` + `IGNORED_DIRS`. Identify services, languages, frameworks. Print a discovery report **before any file mutation.**
2. **Build initial graph.** Run static extraction (per [static-extraction.md](./static-extraction.md)). Write snapshot.
3. **Register.** Write a project entry to `~/.neat/projects.json` (per [project-registry.md](./project-registry.md)).
4. **Generate SDK install patch** for every detected service (per [sdk-install.md](./sdk-install.md)).
5. **Apply or hold.** With `--apply`, the patch is applied directly. Without it, the patch is written to `neat.patch` for user review and `NEAT_INSTRUMENT.md` explains how to apply.
6. **Reload daemon.** If running (per [daemon.md](./daemon.md)), signal it to pick up the new project.

## Patch-by-default; `--apply` is opt-in

Init **never** modifies user code without explicit consent. The codemod path produces a patch file for review; only `--apply` runs the patch in-place. `--dry-run` prints without writing.

## What `init` doesn't touch by default

- Manifests (`package.json`, `requirements.txt`, `pyproject.toml`, `Gemfile`, `pom.xml`) — only modified under `--apply`.
- Lockfiles — never modified directly. Post-`--apply` prints "run `npm install`" so user owns the lockfile commit.
- `.env` and config files — never modified.
- Running processes — never instrumented; SDK install only modifies start commands for next-process start.

## Discovery report

Lists what `init` will / won't do, what it found, what it skipped. Includes services + language + framework, files patched if `--apply`, target SDK package versions, runtime overhead estimate.

## Idempotency

Re-running on already-initialized: re-runs discovery, overwrites registry entry, re-generates patch (skipping applied changes), re-builds snapshot. No double-install, no duplicate registry entries.

## Project naming

`--project <name>` overrides; default is `<path>` basename. Names unique within `~/.neat/projects.json`; collisions fail loudly.

## `init` and `install` are one command

The audit's split is rejected. One command with `--apply` flag handles both.

## Authority

Owned by `packages/core/src/cli.ts`. Composes `extract/*`, `persist.ts`, `installers/`, `registry.ts`. Does **not** start the daemon — that's `neatd start`.

## Enforcement

`it.todo` for v0.2.5 #119. Discovery-before-mutation is a CLI test (`init --dry-run`, assert no file changes).

Full rationale: [ADR-046](../decisions.md#adr-046--neat-init-contract).
