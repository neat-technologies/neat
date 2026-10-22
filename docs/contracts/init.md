---
name: init
description: neat init is one-time registration. Discovery before mutation. Patch-by-default; --apply opt-in. Lockfiles never touched. Idempotent. init and install are one command.
governs:
  - "packages/core/src/cli.ts"
  - "packages/core/src/installers/**"
  - "packages/core/src/registry.ts"
adr: [ADR-046, ADR-026, ADR-027, ADR-273]
enforcement: [lint, review]
---

# `neat init` contract

The first of four v0.2.5 distribution-layer contracts. Sibling contracts: [`sdk-install.md`](./sdk-install.md), [`project-registry.md`](./project-registry.md), [`daemon.md`](./daemon.md).

## One-time registration

`neat init <path>` is the install moment. Like `brew install` followed by `claude init`. Re-running is idempotent but the user's mental model is install-once.

## What `init` does, in order

1. **Discover.** Walk `<path>` honoring `.gitignore` + `IGNORED_DIRS`. Identify services, languages, frameworks. Print a discovery report **before any file mutation.**
2. **Build initial graph.** Run static extraction (per [static-extraction.md](./static-extraction.md)). Write snapshot.
3. **Give the project its identity, then register it.** Write `<path>/.neat/project.json` with a freshly minted `projectId` (or keep the one already there), `<path>/.neat/binding.json` as `local` unless one exists, and `<path>/.neat/.gitignore` listing `binding.json` and `connectors.json` ([`project-identity.md`](./project-identity.md), ADR-273). Then index it in `~/.neat/registry.json` under that `projectId` (per [project-registry.md](./project-registry.md)).
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

Re-running on already-initialized: re-runs discovery, keeps the existing `projectId` and binding, refreshes the registry row, re-generates patch (skipping applied changes), re-builds snapshot. No double-install, no duplicate registry entries, and never a second identity for the same repo. Running `init` in a directory that was registered before ADR-273 (a legacy row) mints its identity and keeps its name — that is the one-time adoption.

## Project naming

`--project <name>` sets the display name; default is `<path>` basename. Names are not keys and may repeat across the machine (ADR-273): a second `api` is a second project with its own `projectId`, and `neat list` tells them apart by id and path. When the name is already used elsewhere, `init` says so and where, and carries on.

## `init` and `install` are one command

The audit's split is rejected. One command with `--apply` flag handles both.

## Authority

Owned by `packages/core/src/cli.ts`. Composes `extract/*`, `persist.ts`, `installers/`, `registry.ts`. Does **not** start the daemon — that's `neatd start`.

## Enforcement

`it.todo` for v0.2.5 #119. Discovery-before-mutation is a CLI test (`init --dry-run`, assert no file changes).

Full rationale: [ADR-046](../decisions.md#adr-046--neat-init-contract).
