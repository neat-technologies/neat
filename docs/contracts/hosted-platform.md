---
name: hosted-platform
description: Hosted NEAT is the full managed suite (Supabase-shape) — graph, daemon, the remediation runner, dashboard, auth, CLI/MCP endpoints, managed — an outer layer wrapping the unchanged, tenant-agnostic local core. The only local↔hosted swap point is the profile source (platform list) + the bearer; storage is Postgres+pgvector; the runner runs hosted as the execution venue. Hosted wraps, never forks.
governs:
  - "packages/core/src/daemon.ts"
adr: [ADR-107, ADR-102, ADR-103, ADR-106]
enforcement: [review]
---

# Hosted platform contract

🟡 **Contract-only — opens with the build.** This fixes the *shape and the seam* at seam-altitude; the mechanics (the control plane, tenant provisioning, billing, the auth provider) open with the build (ADR-107). Hosted NEAT is the **full managed suite (Supabase-shape)** — graph, daemon, the remediation runner, dashboard, auth, and the CLI/MCP endpoints, managed — not a read replica.

## 1. An outer layer wrapping the tenant-agnostic core

Hosted is an **outer layer** around the unchanged local core. The graph engine, daemon, and MCP server stay tenant-agnostic — they know nothing of tenants. Tenancy, billing, and auth live entirely in the outer layer. Hosted **wraps, never forks**: the FOSS local product stands alone and the hosted layer adds to it.

## 2. The profile source is the only local↔hosted swap point

Every client (GUI, CLI, MCP) reaches a tenant's daemon through the **profile** ([`client-profiles.md`](./client-profiles.md), ADR-102). The *only* difference from local is the profile **source** and the **bearer**:

- **Local:** enumerate `~/.neat/daemons/*.json` discovery.
- **Hosted:** enumerate the **platform's project list**, each entry carrying its `endpoint` + bearer `authToken`.

Same clients, same code path. This is the seam ADR-102 §7 fixed; hosted hooks in additively by swapping the source and adding the token — no client rewrite.

## 3. Auth + multi-tenancy

Per-tenant isolation; bearer tokens on every interface (ADR-073 single-source rule holds). A tenant's GUI/CLI/MCP only reach that tenant's daemons via the profile's endpoint + bearer. The auth provider, tenant boundary, and isolation guarantees land with the build.

## 4. Storage

The hosted graph, embeddings, and bounded traversal live in one Postgres — relational graph + `pgvector` + recursive CTEs ([`hosted-storage.md`](./hosted-storage.md), ADR-103).

## 5. The remediation runner runs here, "by us"

The autonomous-remediation runner ([`autonomous-remediation.md`](./autonomous-remediation.md), ADR-106) runs hosted as its **execution venue** — "remediation by us." Hosted is where NEAT drives the propose→gate→graduate loop on a tenant's graph; the loop and its determinism wall are unchanged from local.

## 6. One architecture, two scales

Local and hosted are the same architecture: in-memory graphology + per-project daemon locally; Postgres-backed, multi-tenant, profile-sourced from the platform list hosted. The launch principle — local-first, hosted additive ~1–2 weeks later — is this seam made concrete.

## Authority

The outer layer (control plane / auth / tenancy / billing) lands in its own surface when the build opens; the core (`daemon.ts`, MCP, the graph engine) stays tenant-agnostic and unchanged. The seam is the profile source ([`client-profiles.md`](./client-profiles.md)) + the storage backend ([`hosted-storage.md`](./hosted-storage.md)).

## Enforcement

`enforcement: [review]` while contract-only — the platform is unbuilt, so the active check is review. As it lands it gains **breaker** (a hosted profile drives the read/OBSERVED surface over a bearer; tenant isolation holds) and **lint** (the core carries no tenant-aware branch — tenancy stays in the outer layer). Tagged per ADR-104.

Full rationale: [ADR-107](../decisions.md#adr-107--hosted-platform-the-managed-neat-suite-supabase-shape).
