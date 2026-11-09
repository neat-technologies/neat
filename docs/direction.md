# Where NEAT is going

This is the direction of the product, written down so that every session, human or agent, builds toward the same thing. It is loaded with `CLAUDE.md`. It is not a contract and not an ADR: a direction becomes an ADR only after the research and the experiment behind it hold (ADR-212), and a contract only once the ADR is accepted. What this file does is name the destination, say what exists today, and name the gate each step has to pass. If you are about to build something that is not on this path, say so first.

**v1 ships when every direction below is either built or explicitly cut.** Until then, work on NEAT is graded against this file the same way code is graded against the contracts.

## The purpose

An agent must not be able to create a regression — in NEAT itself, or in the system of anyone using NEAT. Everything below serves that one sentence. Autonomy is the first number NEAT is measured on; regressions introduced per task is the second, and it is the one that quantifies the purpose.

## What NEAT is

The canonical statement is the [README](../README.md). The short form: a live graph of a running software system, built for an agent to query instead of investigate. Every edge carries its provenance; fusion joins what the code declares, what the runtime did and what the system was given, at the same grain; every feature is a read of that one graph. No LLM anywhere in the product.

Features are products of the graph in the multiplying sense: graph × provenance × time × a question. Divergences, root cause, blast radius, dependencies, policies, incidents and grades are each a read of the same substrate. None of them is its own layer.

## Rules that are decided now

These are binding today. Where a rule has no contract home yet, the home it moves into is named; until then this file is the authority.

1. **NEAT is built like circuitry.** A feature is a module on the substrate with one entry point; it reads the graph through the query surface and never through another module's internals; a new capability is a new module plus additive schema, never a special-case branch in an existing one. Dependency direction runs one way: types → substrate (`graph`, `ingest`, `extract/*`, `persist`, `traverse`) → queries → surfaces (REST, MCP, CLI, web) → edges (installers, connectors, deploy). Home: the substrate contract and the layer lint under #1373.
2. **Pull and push return the same answer.** An agent working on its own task queries the graph; it never fetches a card. NEAT pushes a composed incident when it detects something worth pushing. The card is the shape of the answer, not a layer (ADR-244, `incident-card.md`).
3. **Ask NEAT every time.** Every agent-facing surface routes investigation through the graph before raw search, in order: incidents, divergences, root cause, blast radius, dependencies, then grep. In debugging mode the search hook is loud when NEAT was not consulted; the default and the detection are the maintainer's switch (`NEAT_SEARCH_DEBUG_LOUD`).
4. **Enforcement lives in NEAT's own surfaces first.** A policy that blocks is refused by the daemon, the MCP tool and the CLI; hooks into an agent runtime are the ceiling on top of that floor, never the only gate.
5. **The human stays where the grade puts them.** A composed incident whose grade bands `out` goes to a person, said plainly as "human needed". Locally, NEAT never merges a pull request it authored. On hosted, the user decides whether NEAT may. Home: the incident-card contract for the band, the hosted-platform contract for the merge setting.
6. **NEAT writes the rule, not the human.** When an incident resolves, the policy that stops it recurring is authored from the graph (root cause, blast radius, the incident as its evidence) and staged for acceptance the way a FrontierNode is — never typed by a person. A console view of those rules comes later.
7. **What gets pushed is a policy.** The default set is regressions, CI failures and divergences — the regular things, not every small finding. The set is configurable in the project's policies.
8. **No absolute outcome claims.** Repo and public text never says NEAT makes something impossible, or that an agent cannot or will never do a thing. Say what the tooling does; let the reader draw the outcome (`comms-voice.md`).

## Directions

Each one names what exists today, the gate it must pass before it becomes an ADR, and its first step.

### 1. Policies bound to nodes, fired at the agent's hands

**Direction.** A policy hangs on the nodes it protects. Blast radius says what those nodes reach. When an agent reads or edits anything in that radius, the policy fires — in the daemon, the MCP tool and the CLI first, in the agent's hook second — so the mistake is stopped before it lands, every time, deterministically.

**Today.** Six policy rule types evaluated over the graph (`policy-schema.md`); `blast-radius` is one of them; `block` applies to FrontierNode promotion only (`policy-actions.md`); the Claude Code plugin has a PreToolUse hook and mid-session monitors; the search hook nudges toward the graph. The pieces exist apart. The binding policy → nodes → surface does not.

**Gate.** A written design of the binding (which node attributes carry the policy, how the radius is computed at read time, what "fire" means per surface) and a reproduction on the demo fixture where an edit inside the radius is refused.

**First step.** An issue with the design options, then the ADR.

### 2. NEAT authors the policy after an incident

**Direction.** Rule 6, built. A resolved incident produces a staged policy carrying the incident id as evidence; acceptance promotes it; a rejected one is recorded.

**Today.** The incident ledger and grade exist (ADR-221, ADR-238); policies are a file the user writes; FrontierNode promotion is the accept/reject pattern to reuse (`frontier-promotion.md`).

**Gate.** An experiment on three resolved bench incidents showing the authored policy would have caught the recurrence and would not fire on healthy traffic.

**First step.** Depends on direction 1's binding; sequence after it.

### 3. The push set, policy-configured

**Direction.** Rule 7, built. Which detections produce a pushed incident is read from the project's policies; the shipped default is the regular set.

**Today.** The incident stream pushes on ErrorEvents (`incident-trigger-stream.md`); CI failures have no ingress (neat-infra #196); divergences are a query, never a push.

**Gate.** The policy shape for "push on" as schema growth, and a reproduction where a divergence pushes and a minor finding does not.

### 4. Time as an axis

**Direction.** The graph as a function of time. Snapshots taken at events — incidents, deploys, commits — plus the ledger give three things: a policy carries its birth time and lineage (policy ← incident ← root cause); a composed incident carries the state before and after (the edge was OBSERVED healthy until 14:02, then the env changed, then the errors); every query accepts `at:`.

**Today.** Time exists as stamps on the present: `lastObserved`, the STALE thresholds, the incident ledger, source baselines per commit (`source-baseline.md`), one `graph.json` with append-only sidecars (`persistence.md`).

**Gate.** This is a persistence contract change and the one real design decision in this file. Snapshots keyed on events first; an event-sourced edge ledger only if snapshots prove insufficient. The ADR needs the storage cost measured on the demo and on the bench box's otel-demo tenant.

**First step.** An issue with the snapshot-at-event design and the measurement plan.

### 5. The loop closes

**Direction.** NEAT sits in CI and checks the tests pass. On hosted, a sandboxed Sniper finishes the composed incident through FRONTIER and opens one pull request with everything NEAT added packaged for merge time. A grade of `out` goes to a person. Locally, policies and NEAT's own checks keep the pull request clean and the user finishes it.

**Today.** `neat-action` and `POST /pr-verdict` review a human's PR; the incident stream and the Sniper bridge, runs, credits, review and GitHub handoff exist on the control plane; nothing runs a sandbox (neat-infra #128); no CI ingress (#196); no merge mode (#197); no notifier for `out` (#198); no Sniper run has ever executed, so the band distribution is unknown. Admission by grade band is Sniper ADR-004.

**Gate.** One tenant, one injected fault, one Sniper pull request merged under branch protection, with the band on the run result. The first honest `out` rate comes from that run plus a fault set, on the bench box.

### 6. Hosted is local, kept

**Direction.** Hosted NEAT is local NEAT plus durability, multiple users, multiple projects. Sniper, Signal and dynamic policies live only there. Policies keep one model on both sides: the daemon is the source of truth and the format is the same; on hosted, NEAT-authored rules are an overlay on the repo's `policy.json` and export back to it as a pull request; the control plane keeps only product knobs.

**Today.** One daemon per project on Cloud Run; durability shipped in code and waits on operations (the snapshot KMS key and the runbook gate); one org per email with no invites (neat-infra #195); multi-repo projects can retire each other's file nodes (core #1294); the console reads policies through a GET-only allowlist.

**Gate.** Durability live on staging and the #164 gate green before any push feature ships to a tenant. Multi-user before "the user decides".

### 7. NEAT enforces its own architecture

**Direction.** The fleet that builds NEAT is the first customer of the purpose. Rule 1 becomes a lint that fails CI (#1373), and then a policy over NEAT's own graph, evaluated by NEAT (`contract-enforcement.md` §5).

**Today.** `contracts.test.ts` holds hundreds of one-off assertions in this spirit and no general layering rule; no import-boundary lint; three import cycles in `packages/core/src`.

**Gate.** The layer map agreed; the lint green on main with the three cycles as a shrinking allowlist; then a seventh policy rule type that expresses "no edge from these files to those".

### 8. The second number

**Direction.** Regressions per task, same model with and without NEAT: the share of tasks where a test that passed before the agent's change fails after it. Measured on the bench box, never in this repository, to the same bar as the divergence number (randomised arm order, output tokens reported, identical source for both arms).

**Today.** Defined, queued behind the eight-arm run, not yet measured. It is a hypothesis until it is.

### 9. More of what the system was given

**Direction.** Fusion reads config and environment as sources beside code and runtime: a feature flag's live state against its committed default, fused onto the services whose code gates on it (ADR-242); a crashed workload's environment, arguments and process log on its node at ingest, read by every surface from the graph (ADR-243).

**Today.** ADR-242 is proposed, ADR-243 is on a branch pending the bench re-run; the Kubernetes connector already fuses substrate nodes.

**Gate.** ADR-242's transport ruled; ADR-243 verified on scenario 414.

## What v1 means

v1 is the release where the purpose can be stated as shipped reality: an agent using NEAT queries the graph by default, is stopped by a policy before it edits inside a protected radius, is handed a composed incident with its before and after when something breaks, and the rule that stops the recurrence is written by NEAT. Each direction above is either on main or cut by then, and the two numbers are measured.

## How a direction graduates

Direction (this file) → research and experiment on the box or the demo → ADR with the numbers (ADR-212) → contract with an enforcement tag (`contract-enforcement.md`) → code. Nothing skips a step, and nothing in this file is cited as if it were already true.
