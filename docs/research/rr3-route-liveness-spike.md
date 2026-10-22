# R-R.3 spike: route liveness and shadow routes

*Research only (sprint 2026-10-22). Nothing here is merged; the spike test is `packages/core/test/spike-rr3-route-liveness.test.ts` on branch `spike-rr3-route-liveness`, and it passes against main at ce3ee6d.*

## What the graph does today

- **A declared route nobody calls raises nothing.** Ingest stamps an OBSERVED `service ──CONTAINS──▶ route` only when a SERVER span fuses to that route (`ingest.ts`, the `findRouteNodeByHttpRoute` / `findRouteNodeByRequestPath` block). `divergences.ts` skips every CONTAINS bucket in `missing-observed` (structural ownership, by design). So a route with an EXTRACTED CONTAINS and no OBSERVED one is not a divergence anywhere. Spike case 1 shows it: `/admin/export` is declared, never hit, and nothing names it.
- **A route served but never declared leaves no node.** On a miss, `findRouteNodeByHttpRoute` mints nothing ("the served-but-undeclared case is a follow-on"). The traffic still lands on the service, but the endpoint is invisible at route grain. Spike case 3 shows it.

## Prototype 1: `route-unexercised`

The rule: a RouteNode with an EXTRACTED CONTAINS and no OBSERVED CONTAINS, on a service where **at least one** of its routes has an OBSERVED CONTAINS.

- The second clause is the instrumentation gate. A service with no route traffic at all says nothing, so an uninstrumented service or a quiet window never reads as "every route is dead" (spike case 2).
- It runs at node grain, the CONTAINS-allowlist gap the divergence detector can't cover without un-excluding CONTAINS for every structural edge.

**Decisions for Deniz:**
1. **Where it lives.** A seventh divergence type (`route-unexercised`, amends divergence-query.md), or a Recon-only report that never reaches the card. Recommendation: Recon-only first. A route never hit in a 10-minute bench window is not a fault, and on the card it would be noise.
2. **Window.** "Never" needs a horizon. Options: since daemon start, the last N hours of OBSERVED, or a Recon run's own exercise window. Recommendation: the Recon run's window, since the exerciser is what makes "never hit" mean something.
3. **Methods.** `ALL` routes (nginx, gateway) count as exercised by any method. Should a GET-only hit on a route that also declares POST count? Recommendation: per (method, template), as RouteNodes are keyed.

## Prototype 2: OBSERVED-first shadow routes

The rule: after ingest, a SERVER span with a **templated** route (`http.route`, or Next's `next.span_name`) that fused to no declared RouteNode mints one, `discoveredVia: 'otel'`, keyed exactly like the extractor's (`routeId(service, method, template)`). A later extraction then fuses onto it instead of twinning (the ADR-158 §5 / lifecycle.md auto-create-and-merge rule). The node reads as observed-only, which is `missing-extracted` at route grain.

- **Cardinality guard (in the spike):** a span with only a concrete path (`url.path` / `http.target`) never mints. One node per URL would be unbounded, and ADR-253 already joins concrete paths only to declared routes. A repeat span mints nothing new, and a span that matches a declared route mints nothing.
- **Gap the spike leaves:** the prototype mints after `handleSpan`, so the new node has no OBSERVED CONTAINS from that first span. Built for real, the mint belongs inside the ingest block, before the edge upsert, so the first span both mints and stamps.

**Decisions for Deniz:**
1. **Mint, or report only?** Minting changes graph shape from runtime (a new node kind of source for routes). Reporting keeps nodes static-first and lists shadow templates in a Recon report. Recommendation: mint. ADR-158 already licenses observed-first nodes below the file with `discoveredVia: 'otel'`, and a RouteNode is what blast radius and the card walk.
2. **Template trust.** `http.route` comes from the framework's router and is low-cardinality in Express, FastAPI, Spring and Next. Some instrumentations put a raw path in `http.route`. Guard options: reject a template with no parameter segment and a numeric or UUID-looking segment; or cap minted routes per service (for example 200) and stop minting past it with a recorded drop. Recommendation: both.
3. **Lifetime.** Should a minted route that goes quiet go STALE like an OBSERVED edge, or stay? Recommendation: STALE on the CONTAINS edge only, with the node kept, as for symbols.

## Next, if ruled

Each prototype is about 40 lines in src. Prototype 2 belongs inside `ingest.ts`'s route block; prototype 1 is a pure function over the graph (a new module, not divergences.ts, if it stays Recon-only). Both need a contract amendment: divergence-query.md or a Recon contract, and otel-ingest.md for minting.
