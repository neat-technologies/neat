---
name: hosted-storage
description: Hosted NEAT stores the graph, embeddings, and bounded traversal in one Postgres — relational nodes/edges, a pgvector column for fuzzy retrieval, recursive CTEs for blast-radius/root-cause/dependencies/divergence at the local depth caps. No dedicated graph DB, search engine, or fork until CTE traversal strains. Local (graphology + in-process embeddings) is unchanged; the storage backend is the local↔hosted seam.
governs:
  - "packages/core/src/persist.ts"
adr: [ADR-103, ADR-041, ADR-096]
---

# Hosted storage contract

🟡 **Contract-only — opens with the hosted build.** Local persistence (graphology + `neat-out/graph.json`, ADR-041) is unchanged; this governs the hosted backend that sits behind the same persistence seam. It fixes the substrate so hosted code is written against it (ADR-103).

## 1. One store

Hosted NEAT keeps the graph, the embeddings, and runs traversal in a **single Postgres**. No second datastore for vectors, no separate graph server, no search engine.

## 2. Relational graph

Nodes and edges are rows. The property-graph model — type, provenance, confidence, evidence, signal — maps to typed columns / JSONB. The node/edge/provenance model is the same one the local graphology holds (`@neat.is/types`, ADR-041); Postgres is the durable form, not a different model.

## 3. pgvector for fuzzy reach

Node and policy embeddings live in a `pgvector` column. `semantic_search` (ADR-025) and the policy overlay's binding step run as pgvector kNN — the same vector job `search.ts` does locally, at scale. **Vectors retrieve; they never decide a constraint.**

## 4. Recursive CTEs for bounded traversal

Blast-radius, root-cause, dependencies, and divergence run as recursive CTEs at the same depth caps as local (blast-radius ≤ 10, root-cause ≤ 5), with the same `PROV_RANK` selection and multiplicative confidence cascading. Traversal is **exact and deterministic** — a relational computation, never a similarity search.

## 5. The policy overlay runs here, wall intact

Graph-pattern evaluation — the deterministic gate and the structural tail — is relational/CTE queries; the vector-reach is pgvector kNN. Vectors resolve bindings **upstream** of the gate and are frozen into the policy before evaluation; they never enforce.

## 6. No dedicated graph DB, search engine, or fork

Postgres + pgvector is the substrate for launch and until recursive-CTE traversal demonstrably strains under multi-tenant load. Not a search engine (Elastic / OpenSearch can't do the deterministic traversal that is the core), not a forked engine (a hosting business does not own a database fork). PostgreSQL + pgvector are PostgreSQL-licensed — clean for managed hosting, where Elastic (SSPL) / Neo4j (GPL + Enterprise-gated multi-tenancy) / Memgraph (BSL) are not.

## 7. Escape hatch — add, never fork

If CTE traversal strains: an **embedded** per-daemon graph engine (KùzuDB, Apache-2.0, fits the per-project-daemon shape) before an external server; a Bolt-compatible server (Memgraph) as the reversible fallback. Any successor is added behind the persistence layer, never forked.

## 8. Local unchanged; the backend is the seam

graphology + in-process embeddings stay the local substrate. Hosted is an additive backend behind the same persistence interface — the storage backend is the local↔hosted swap point, consistent with the client profile seam (ADR-102) and the per-project-daemon shape (ADR-096). Local and hosted are one architecture at two scales.

## Authority

`packages/core/src/persist.ts` and the future hosted store module behind it.

## Enforcement

Opens with the hosted build. Until then this contract fixes the substrate decision so hosted code is written against it.

Full rationale: [ADR-103](../decisions.md#adr-103--hosted-storage-one-postgres-relational-graph--pgvector--recursive-cte-traversal).
