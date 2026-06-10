# The thesis

NEAT is a graph with a CLI. The rest is geometry.

This document is the architecture NEAT is built toward. Some of it ships today; some of it is the destination the data structure makes inevitable. Where it matters, the text says which is which — because the whole point of NEAT is that it does not claim what it cannot show.

## The graph is the engine

Everything else is what happens when you point an engine at a problem.

Start with what the graph actually is. Two input streams — tree-sitter reading your code, OpenTelemetry watching your production traffic — merged into one continuously updated model where every relationship carries a provenance tag and a confidence score. That is the machine. A handful of node and edge types, a provenance enum, and a traversal algorithm. Nothing more.

Now watch what falls out of it.

## Root cause is a traversal

When `payments-db` fails you do not search logs. You walk backward through incoming edges from the error surface, check compatibility at each node, and stop when you find the cause. The algorithm is depth-first search with a compatibility check at each hop. The result is a path, a reason, and a confidence score that tells you how much of that path was confirmed by live traffic versus inferred from static code. Every root-cause tool in existence is trying to approximate this. NEAT derives it from first principles, because the graph is the right data structure for the problem. **This ships today** as `get_root_cause`.

## Blast radius is a reachability problem

Given a node, walk all outgoing edges recursively. Count the unique nodes you visit. Weight each one by the confidence of the path that reached it. The result is not a list of services that *might* be affected — it is a ranked list of services that are definitely, probably, or possibly affected. Confidence is not a guess. It is a function of provenance: how much of the path between two nodes was confirmed by live OTel traffic and how much was inferred from code. **This ships today** as `get_blast_radius`.

## Policies are the layer between intent and reality

This is the primitive that separates NEAT from every observability tool that came before it. Observability shows you what is happening. Policies declare what must be true. The gap between those two statements is where production failures live.

A policy in NEAT is a persistent assertion. *Only `payment-service` may connect to `payments-db`. No service in the critical path may have an edge with `INFERRED` provenance. Every `ServiceNode` must declare an owner.* These are not alerts — an alert fires after the violation has already occurred. A policy is evaluated continuously and automatically against the live graph, and it has two response modes, decided by one distinction that makes the whole design coherent.

### Facts cannot be un-happened. Proposals can be refused.

A mutation to the graph is one of two things. It is a **fact** — a span that already arrived, code the parser already read — or it is a **proposal** — a change an agent or a deployment *intends* to make but has not made yet.

You cannot reject a fact. When production actually opens a forbidden connection, the span has already fired; the call happened. Throwing that edge away would mean discarding telemetry, which destroys the one thing NEAT sells: honest observed truth. So for facts, a policy violation is **recorded and flagged** — the edge lands, and the violation surfaces as a divergence between declared intent and observed reality. That is the divergence engine, and it is continuous.

A proposal is different. A proposal has not happened. When an agent proposes a change that would violate a `block` policy, the policy engine evaluates the proposed graph — the live model plus the proposed delta — *before* anything lands, and **refuses** it. The same way a database rejects a write that violates a foreign-key constraint before the row commits. The proposal is denied, with a precise explanation of which policy was violated and why.

So the precise statement of how policies run: **policies evaluate on every mutation for observed and extracted facts, and enforce synchronously as a gate on every proposed mutation.** Flag the fact, refuse the proposal. The distinction between the two is the architectural seam that makes NEAT a governance kernel rather than a dashboard.

### Two tiers of enforcement

How strong that refusal is depends on where the check sits — and this is a position in the system, not a property of the engine.

**Cooperative enforcement** is the agent tier. An agent — Claude Code, or any MCP client — calls NEAT to evaluate a proposed change before it acts, and honors the verdict. A well-behaved agent that asks "may I make this change?" and is told "no, it violates the payments-isolation policy" does not make the change. This is enforcement at the speed of the graph for the class of actor that NEAT's primary users deploy: their own coding agents.

**Mandatory enforcement** is the platform tier. The same kernel, wired as a *required* gate — a CI check that fails the build, a deploy webhook that returns non-zero, an admission controller that rejects the manifest. Here the actor cannot skip the check, because the check is positioned in the path the action must pass through. This is the guarantee an enterprise platform team wants: not a notification that a constraint was violated, but the assurance that no deployment, no agent action, no code change can produce a violation without explicit human override.

The kernel is identical in both tiers. The strength of the guarantee is a function of where you position it. Cooperative enforcement is the near term — it is enough for an agent, enough for a demo, enough to make the claim true. Mandatory enforcement is built when a platform team asks for it, not before.

### Why this is governance, not observability

Governance is not retroactive. Governance is the continuous evaluation of whether your system's observed reality matches your organisation's declared intent. The graph is the observed reality. The policies are the declared intent. The evaluation is continuous and automatic. The moment the two diverge, the graph knows — and on a proposal, it does not merely know, it refuses.

## FRONTIER is where a proposal lives before it is real

A `FrontierNode` is one thing in NEAT: a placeholder for an external host the graph has seen but cannot yet resolve to a known service. That is a data-quality concept and it keeps its name.

`FRONTIER` *provenance* is a different axis — a tag on the relationship itself — and it is where the proposal path becomes graph-native. A change an agent is experimenting with — deployed to a subset of traffic, watched over an observation window, evaluated against the baseline before it graduates to `OBSERVED` — exists in the graph as `FRONTIER`-tagged state. Not yet a fact. Not yet rejected. A proposal under evaluation.

The policy layer is the gate on that graduation. A `FRONTIER` relationship whose promotion to `OBSERVED` would violate a declared policy cannot graduate, regardless of what the OTel markers show. An agent cannot override a policy by accumulating positive evidence. The architectural law is enforced at the data-model level, not the application level. This — proposals as graph-native staged state — is the depth the kernel grows into once the gate itself exists.

## The geometry

Each of the following is not a separate feature. Each is a consequence of having the right data structure and asking the right question of it.

**Dependency auditing is provenance filtering.** Show me every dependency that is `EXTRACTED` but has never been confirmed by an `OBSERVED` edge. That is dead code at the service level — relationships your code declares but production has never exercised. NEAT surfaces it by filtering the graph on provenance, and a policy encodes the check permanently: any `EXTRACTED` edge `STALE` for more than seven days with no corresponding `OBSERVED` edge is flagged automatically. Dead dependencies become a continuous audit rather than a periodic one. **This ships today** as `get_divergences`; its collapse into a standard policy bundle is the unification described below.

**Change risk is path confidence.** Before you deploy, query the graph. What is the blast radius. What is the confidence of the paths inside it. A change to a service with an all-`OBSERVED` blast radius is lower risk than one with `INFERRED` edges in the critical path. Risk is not a gut feeling — it is a function of graph confidence. The policy layer adds the second axis: does this change violate a declared constraint. Risk and compliance in one query.

**Incident triage is a graph query.** When an incident fires, the triage report writes itself: affected node, blast radius, incident history, suggested owner, and — the part no other triage tool provides — the active policy violations on the affected nodes. A database connection that violated the exclusive-access policy for three hours before the failure is not just an incident. It is a policy-enforcement gap that *produced* an incident. That distinction is the difference between a post-mortem that blames a service and one that fixes a governance hole.

**Architecture governance is policy compilation.** An organisation's architectural laws are expressed as policies and evaluated against the live graph continuously. The moment a change violates a law, the violation fires — not in the next audit, not in the next architecture review, immediately. The policy file is the architecture review board, running continuously, with no human required to convene it.

**IaC generation is graph serialisation.** The graph knows your topology. Rendering that topology as Terraform is a translation problem: map each node type to its IaC equivalent, each edge to its relationship, output a valid module. The graph already holds the information; the IaC is a different rendering of the same data, with the policies travelling alongside the topology as code.

**PR triage is a graph diff.** A PR changes files; files belong to services; services have nodes and edges. The blast radius of the changed nodes is the blast radius of the PR, and the policies the changed topology would violate are its policy review. A PR that would create an edge violating the exclusive-access policy on a critical database fails the policy check before a human reviews it — architecture review made automatic for the class of change that can be evaluated structurally.

**Autonomous remediation is graph-guided planning.** Given a root cause — `service-b`, `pg 7.4.0`, incompatible with PostgreSQL 15, confidence 1.0 — generate a fix, stage it as `FRONTIER` state, watch the `OBSERVED` edges over a validation window. Before graduation, evaluate every policy against the proposed final state. If any `block` policy would be violated, the graduation does not proceed regardless of how positive the markers look. The policy layer is the final gate between an agent's hypothesis and production reality. Only a human can override a `block`. That is the correct trust boundary.

The last three — IaC generation, PR triage, autonomous remediation — are the geometry the engine makes reachable, built on the proposal path and the kernel. They are the direction, not the current state. They are reachable because the data structure is right, not because each is a separate product to invent.

## The two primitives are incomplete without each other

Policies are not the fourth feature of NEAT. They are the reason the graph is more than an observability tool. Without the graph, policies have nothing to evaluate against. Without policies, the graph has no enforcement layer. The live architecture model tells you what is true. The policy layer tells you what must be true. The gap between them — flagged on a fact, refused on a proposal — is what NEAT closes.

The graph does not "do" root-cause analysis. It does not "do" blast radius. It does not "enforce" policies as a special subsystem. The graph is a directed graph with typed nodes, typed edges, provenance scores, and a mutation path that asks one question — *is this a fact or a proposal* — and answers accordingly.

Everything else falls out of it.

NEAT is a graph with a CLI. The rest is geometry.
