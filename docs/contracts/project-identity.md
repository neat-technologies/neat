---
name: project-identity
description: A project's identity is a committed <repo>/.neat/project.json (projectId prj_<ULID>, name, schemaVersion); how this machine reaches it is a gitignored <repo>/.neat/binding.json (local | hosted + org). Every CLI command, the MCP server and every client resolve the target the same way — explicit --profile/env pin, --project, the nearest .neat/project.json walking up from the cwd, a legacy registration with a notice, else an error — and route by THAT project's binding. A global active profile never routes. A local-only command on a hosted binding fails loudly. Every response names project · binding · daemon.
governs:
  - "packages/core/src/project-identity.ts"
  - "packages/core/src/cli.ts"
  - "packages/core/src/registry.ts"
  - "packages/mcp/src/base-url.ts"
adr: [ADR-273, ADR-048, ADR-096, ADR-102, ADR-229, ADR-259]
enforcement: [lint, review]
---

# Project identity and binding contract

"Project" used to mean a codebase, a name, a locality, a daemon, an account scope and a set of connectors all at once, and locality was a **global** setting: one `neat login` made every bare client on the machine read from hosted, so a local repo's `neat up` printed "✓ Ready" against a hosted daemon (#11), two directories registered as `default` collided (#6, ADR-229), and connectors leaked across projects (#4). This contract splits what a project **is** from how this machine **reaches** it, and makes locality a per-project binding resolved per command ([ADR-273](../decisions.md#adr-273--a-projects-identity-is-committed-in-the-repo-and-its-locality-is-a-per-project-binding)).

Sibling contracts: [`project-registry.md`](./project-registry.md) (the machine index), [`init.md`](./init.md) (where identity is minted), [`client-profiles.md`](./client-profiles.md) (credentials and the address book), [`connector-config.md`](./connector-config.md) (project-scoped connectors), [`daemon.md`](./daemon.md).

## 1. `<repo>/.neat/project.json` — committed identity

```json
{ "schemaVersion": 1, "projectId": "prj_01JB6K3Z8Q9W2N4R5T7V8X0Y1A", "name": "newdryve" }
```

- **`projectId`** is the canonical identity everywhere: the machine registry, the daemon's discovery record, `neat-out/`, the control plane, hosted. Format `prj_` + a 26-character Crockford-base32 ULID. Minted once by `neat init` and never changed by NEAT afterwards; a re-init keeps it. Two checkouts of the same repo share it, which is what lets one repo be local for one person and hosted for a teammate.
- **`name`** is for people. It defaults to the directory's basename, may repeat across the machine, and is never used as a key.
- The file is meant to be committed. It carries no secret and no machine-specific value.
- A `schemaVersion` NEAT doesn't know is an error naming the file, never a guess.

## 2. `<repo>/.neat/binding.json` — gitignored, per machine

```json
{ "schemaVersion": 1, "binding": "local" }
{ "schemaVersion": 1, "binding": "hosted", "org": "org_01JB…" }
```

- `binding` is `local` or `hosted`. A project is one or the other at a time (ADR-273 decision 2); live local+hosted sync is out of scope.
- `hosted` requires `org`; a hosted binding without one is an error.
- An optional `daemonHint: { port }` records the local daemon's last port as a hint only; the discovery record (§4) is the truth.
- **Absent means local, and the output says so** ("no binding.json — treating <name> as local"). NEAT never assumes hosted.
- `neat init` writes `<repo>/.neat/.gitignore` containing `binding.json` and `connectors.json`, so the user's own `.gitignore` is never edited and those two files stay out of commits.
- **Provisional:** keeping `connectors.json` gitignored is the safe default, not a settled decision. Whether a project's connector references are committed (shared with teammates) or kept per machine is open for Deniz (ADR-273, open points). `binding.json` stays gitignored either way.

## 2a. The `.neat/` directory is open-ended

`.neat/` holds a project's NEAT files. The ones this contract defines are `project.json` (committed), `binding.json` (gitignored) and, per [`connector-config.md`](./connector-config.md), `connectors.json`. The set is **not closed**: other per-project files may sit beside them, committed or not, under their own contracts, and a reader ignores files it doesn't know. `recon.yml` is reserved for NEAT Recon's committed gate policy (proposed, R-R.4). A new file's commit status is decided by its own contract and, when gitignored, added to `.neat/.gitignore`.

## 3. Resolution — one algorithm for every surface

Every CLI command, the MCP server, and any other client resolve their target project in this order, stopping at the first that answers:

| # | Source | Result |
|---|--------|--------|
| 1 | `--profile <name>` / `NEAT_PROFILE`, or the env pin `NEAT_CORE_URL` / `NEAT_API_URL` (+ `NEAT_AUTH_TOKEN`) | an **explicit endpoint**, used as given. The binding header (§6) reads `binding=pinned`. A named profile the store doesn't have is an error (client-profiles.md §3). |
| 2 | `--project <projectId \| name>` / `NEAT_PROJECT` | that project from the machine registry. An id matches exactly. A name must match exactly one registered project; a name shared by several is an error listing their ids and paths. An unknown id or name is an error. |
| 3 | the nearest `.neat/project.json` at or above the cwd | that project |
| 4 | a legacy registration: the cwd is at or under a path registered before ADR-273, with no `.neat/project.json` | that project, by its legacy name, as `local`, with a notice on stderr: "<name> has no .neat/project.json yet — run `neat init` to give it a project identity". Nothing is written to the repo. |
| 5 | none of the above | **an error**: "no NEAT project here — run `neat init`, or pass `--project`". There is no `default` project and no fallback to whichever daemon owns loopback. |

**The global active profile is not a routing input.** `neat login` / `logout` manage credentials (client-profiles.md §4); being logged in changes nothing about where a local-bound project's commands go. The level-4b "sole running daemon" shortcut (ADR-259) is retired with it: a command run outside any project errors at level 5 and names the running daemons, rather than quietly picking one.

## 4. Routing — by the resolved project's binding

- **`local`** → this machine's daemon for the `projectId`: its discovery record `~/.neat/daemons/<projectId>.json` (daemon.md). No running daemon is an error naming how to start it (`neat up`), never a silent loopback.
- **`hosted`** → the endpoint and bearer for `(org, projectId)` from the account's credentials (client-profiles.md §4). Until the control plane registers hosted projects (Phase 1, `neat project promote`), a hosted binding resolves through the profile store entry for that `org`; with none, it is an error naming `neat login`.

## 5. Honest routing — local-only commands on a hosted binding fail

Commands that act on this machine — `neat up`, `neat watch`, the bare-`<path>` orchestrator, `neat init --apply`'s daemon start, the SDK installers' daemon wiring — are local-only (client-profiles.md §5). On a project whose binding is `hosted` they **exit non-zero** with:

> `<name> is hosted (runs in <org>); it isn't yours to start here. Use `neat open` to connect to it, or `neat project set-local` to make it local on this machine.`

They never print a ready line, never start a local daemon for a hosted project, and never fall through to a remote endpoint.

## 6. The binding header — every answer says what it talked to

Every daemon response, every MCP tool result and tool error, the MCP `neat://status` resource, and every CLI read verb's output carry one line:

```
project=<name> (<projectId>) · binding=<local | hosted@<org> | pinned> · daemon=<endpoint or pid:port>
```

- The daemon sets it as the `neat-binding` response header, from the identity it was started with.
- The CLI prints it as the first line of a read verb's output, and on stderr on any error.
- The MCP server appends it to every tool result and every tool error, and serves it at `neat://status`.

A client never has to guess which project or daemon answered.

## 7. Rollback

`NEAT_LEGACY_ROUTING=1` restores the pre-ADR-273 resolution (the client-profiles §3 chain with the `active` profile and the name-keyed registry) for one minor release after the resolution rewrite ships. It exists only as a rollback path: it prints a deprecation line on every use, and its removal is tracked in the issue that ships the rewrite.

## Authority

`packages/core/src/project-identity.ts` owns reading and writing `.neat/project.json` / `.neat/binding.json`, the ULID mint, and the resolution in §3–§4. The CLI (`cli.ts`), the MCP server (`mcp/src/base-url.ts`) and the registry call into it; none re-implements a step (core #1373).

## Enforcement

- A test that `neat init` on a fresh directory mints a `prj_` id and a `local` binding, and a re-init keeps the id.
- A test per resolution level, including that a logged-in `active` profile does not change a local project's target, and that level 5 errors.
- A test that `neat up` on a hosted binding exits non-zero with the §5 message and starts nothing.
- A test that an MCP tool result and error carry the §6 line.
