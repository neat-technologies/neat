# R-R.2 — OpenAPI ingest + input-gen (spike notes)

*Throwaway / research-only, NOT for merge. Companion to bench's R-R.1 `e2e/recon/exercise.ts`.*

## The seam (grounded in bench's exerciser)
`e2e/recon/exercise.ts` reads RouteNodes from the daemon `GET /graph` and fires one request per route via `requestFor(n) → {method, url, init}`. Today that sends `PARAM=1` for every path param and `{}` for a body — bench's own comment: *"enough to reach the handler and emit a span, not to pass validation. Generating valid inputs is R-R.2's job."*

So R-R.2 is a **drop-in richer `requestFor`**:
```
buildRequest(route, contract?, {token, seed, paramValue}) → { method, url, init }
```
same return shape; when an OpenAPI operation is attached to the route it generates valid path params + required query + a schema/example body + the auth header; falls back to bench's naive behavior when no contract. Bench imports it: `import { buildRequest } from './inputgen.js'` and calls it per route instead of its local `requestFor`.

## Keying (attach spec → RouteNode)
Attach each OpenAPI operation to a route by **`${METHOD} ${normalizePathTemplate(path)}`** — the same key `routeId(service, method, pathTemplate)` uses (`packages/types/src/identity.ts:152`), normalized through `normalizePathTemplate` (`packages/core/src/extract/routes.ts:445`) so an OpenAPI `/pets/{petId}` and the extracted RouteNode's `pathTemplate` collapse to one key. `attachOpenApi(spec, service) → Map<routeKey, OperationContract>`; `buildRequest` looks the contract up by the route's own key. No live graph needed for the logic — the map keys to whatever RouteNodes the graph holds.

## Valid-input generation (the #1 hard part)
Per operation, resolve in precedence order (example wins — it is ground truth the author gave):
1. **path params** — operation/param `example` → schema `default`/`enum[0]` → generate-by-type/`format` (integer→1, string→"x", uuid→a fixed uuid, date→ISO) → else `paramValue` (naive fallback).
2. **query** — only **required** params by default (+ ones with examples); same value precedence.
3. **body** (POST/PUT/PATCH) — requestBody `example`/`examples[0]` → `genFromSchema(schema)`: object with every `required` prop filled, string/number/bool/enum/array(one item) by type+format; `{}` fallback.
4. **auth** — read `security` + `components.securitySchemes`: `http bearer` → `Authorization: Bearer <token>`; `apiKey` → that header/query; `token` is user-supplied (`opts.token`), never invented.

`genFromSchema` is small and prefers examples; it proves the approach, it is not a full JSON-Schema faker (Schemathesis/`json-schema-faker` are the production answer — noted, not pulled into the spike).

## Residual hard parts (can't be solved by schema alone — per recon-architecture.md §52)
- **Real IDs** — a generated `petId=1` 404s if nothing with id 1 exists. Needs a seed/fixture or a create-before-read.
- **Stateful ordering** — POST (create) must run before GET/{id} (read) of the created resource. v1: order by method (POST→GET→PUT→DELETE) and thread created ids where a response example gives one; full sequencing is out of scope.
- **Live auth** — a real bearer must be user-supplied (`--token` / `NEAT_AUTH_TOKEN`), not generated.
These are why **OpenAPI repos are the beachhead** and why v1 findings lean on HARD signals, not blind fuzzing.

## Feed-path priority — DECISION (to verify on the fixture)
Recon doc lists three OpenAPI feed paths + a Zod fallback. Grounded recommendation:
1. **Repo spec file** (`openapi.yaml|json`, `swagger.json`) — *first*: zero runtime, committed = reviewable, travels with the repo. Cheapest, highest-trust. Glob common names/locations.
2. **Runtime `/openapi.json`** — *second*: FastAPI/NestJS/Nest-Swagger serve it live; the flush step can pull it from the running app (we already have it up to exercise). Best fidelity (matches what's actually served) but needs the app running + the route known. Natural fit because Recon runs the app anyway.
3. **zod-to-openapi** — *third*: for repos that declare Zod but no spec (Newdryve). Lift the existing `zod-shapes` (ADR-170) via `@asteasolutions/zod-to-openapi`, then feed path 1. Higher effort, but it is the path that unlocks the large "Zod, no OpenAPI" population.
4. **Zod-inference direct-to-route** (no OpenAPI) — fallback oracle only (ADR-170 column-grain), weaker input-gen.

Rationale: 1 and 2 are nearly free and give full request schemas; 3 is the real engineering cost but the one that matters for the common no-spec repo. **e2e/capture/app has NONE of these** (7 param-less GET routes, no spec, no Zod) — so it validates that a param-less app needs no input-gen and falls to bench's naive flush + the divergence vocabulary; the input-gen value only shows on a spec'd/Zod'd app → hence the fixture below.

## Fixture (where the two spikes visibly join)
`e2e/recon/fixtures/` — a tiny Express `petshop.cjs` (GET /pets?limit, GET /pets/{petId}, POST /pets {name, tag?}, bearer-guarded) + `petshop.openapi.json`. Proves: naive flush → 400/401 wall; input-gen → schema-valid requests that reach the handler (2xx or past-validation). Offline test validates the generated body against the schema (ajv) — no live run needed to prove "valid"; live firing waits for the swap/bench join.

## Status
- [x] seam + keying + buildRequest design
- [ ] inputgen.ts (attachOpenApi + buildRequest + genFromSchema)
- [ ] fixture spec + app
- [ ] offline schema-validity test
- [ ] feed-path decision verified on fixture → write-up to GTM
