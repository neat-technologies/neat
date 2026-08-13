# EAS Build-Failure Connector — v1 plan (phase-mapped)

**Status:** plan, pending implementation · **ADR:** 185 (draft below) · **Scope chosen by Cem:** phase-mapped
**Owner lane:** ubiquity (new provider) + fusion-depth (OBSERVED → root-cause on the CI domain)

## Why this is on-thesis (and `eas.json`-parsing is not)

Parsing `eas.json`/`app.json` as static infra is weak — build *config* emits no runtime signal, so it can't fuse. But an EAS build **failure** is an OBSERVED event about the repo: it ran real code at a real commit and broke. Tracing that failure back to the source node that caused it, so an agent can fix it, is NEAT's root-cause query pointed at a new failure domain (CI builds). It clears the "static tools already do this" bar because the signal is runtime, and the join back to source is exact (commit hash).

The loop we're enabling: **EAS build errors → NEAT pulls it → maps it to the repo node → agent queries `get_incident_history`/`get_root_cause` over MCP → fixes in the repo.**

## Grounded EAS API facts (verified against live `expo/eas-cli` main, 2026-08-13)

- **Endpoint:** `POST https://api.expo.dev/graphql`. **Auth:** `Authorization: Bearer $EXPO_TOKEN` (use a **robot user** token for a server connector, not a personal token). The public GraphQL API is **undocumented and unversioned** — reconstruct types from eas-cli's generated schema; treat drift as the top risk.
- **Do NOT shell out to `eas build:view --json`** — the CLI's own `BuildFragment` omits `error.buildPhase` and still selects the deprecated `logFiles`. Write our own query.
- **Query to write** (list newest-first, filter to failures):
  `{ app { byId(appId: String!) { builds(offset: Int!, limit: Int!, filter: { status: ERRORED }) { id status platform buildProfile gitCommitHash gitCommitMessage gitRef isGitWorkingTreeDirty createdAt completedAt error { buildPhase errorCode message docsUrl } logFileUrls artifacts { xcodeBuildLogsUrl } } } } }`
- **`status`** enum: `ERRORED` (ran & failed — our target), `CANCELED` (aborted — skip), `FINISHED` (success — skip), plus in-flight states.
- **`error.buildPhase`** is a **strict enum** — the reliable structured classifier. Relevant values for mapping (below). **`error.errorCode`** is **free-text (not an enum)** — a hint only, hand to the agent; never switch strictly on it.
- **Logs:** `Build.logFileUrls: [String!]!` — array of downloadable log URLs (fetch and concatenate). iOS full detail is a separate artifact `artifacts.xcodeBuildLogsUrl` (can be ~10MB). URLs are **time-limited signed links** → fetch-and-store on poll, don't persist the URL.
- **The join key:** `Build.gitCommitHash` (+ `gitCommitMessage`, `gitRef`). Also a server-side filter. `isGitWorkingTreeDirty` flags a dirty-tree build whose hash doesn't fully represent what built.
- **Pagination** is offset-based (`offset`/`limit`), not cursor — page newest-first, dedupe by `id`, expect drift if builds are created mid-page.

## v1 scope: phase-mapped

Poll EAS for `ERRORED` builds (per configured Expo app), newest-first, dedupe by build `id` against what's already ingested. For each failure, mint **one build-failure incident** anchored to the repo node the phase implicates, provenance **OBSERVED**, carrying `{ buildId, platform, buildProfile, buildPhase, errorCode, message, docsUrl, gitCommitHash, gitRef, isGitWorkingTreeDirty, createdAt, logsText (fetched & size-capped) }`.

### `buildPhase` → affectedNode mapping (the deterministic core)

| Phase(s) | Maps to | How |
|---|---|---|
| `READ_PACKAGE_JSON`, `INSTALL_DEPENDENCIES` | `package.json` ConfigNode (+ the named dependency if `message` names one) | config/dep failure — deterministic |
| `READ_APP_CONFIG` | `app.json` / `app.config.*` ConfigNode | deterministic |
| `READ_EAS_JSON` | `eas.json` ConfigNode | deterministic |
| `CONFIGURE_EXPO_UPDATES`, `CALCULATE_EXPO_UPDATES_RUNTIME_VERSION` | the expo-updates config (app config ConfigNode) | deterministic |
| `PREBUILD`, `RUN_GRADLEW`, `GRADLE_BUILD_PROFILE`, `FIX_GRADLEW`, `INSTALL_PODS`, `RUN_FASTLANE`, `CONFIGURE_XCODE_PROJECT`, `PARSE_XCACTIVITYLOG`, `EAGER_BUNDLE` | the **app/service node** + attach logs | native compile — NEAT surfaces, agent reads logs |
| `PREPARE_CREDENTIALS`, `SPIN_UP_BUILDER`, `RESTORE_CACHE`, internal/infra phases | **do not mint a repo incident** | not a repo-fixable failure (creds/infra) |

Config/dep phases land on a ConfigNode the extractor already produces (`app.json`/`eas.json`/`package.json` exist in the graph), so the incident fuses onto an existing node and `get_incident_history` surfaces it there. Native phases anchor to the app node with logs, and the agent root-causes. This is the phase-mapped promise: deterministic attribution where the enum allows, honest log-handoff where it doesn't.

### Fuse, don't twin

`affectedNode` must be resolved through the **same fused-node resolution the OTel incident path uses** (cf. #988/#992 `resolveFusedServiceId` and the ConfigNode ids the extractor mints) so a build incident lands on the *extracted* node, not a connector-minted twin. Follow the **firebase connector**'s incident-emission precedent (`connectors/firebase/map.ts` + `resolve.ts`) — that's the existing path for a connector minting incident/error events; do not invent a parallel one.

### Guardrails (mandatory — these are the honesty of the feature)

1. **Filter transient/infra failures.** An "EAS down" / `INTERNAL_SERVER_ERROR`-class failure comes back as `ERRORED` too. Classify via `buildPhase` (infra phases above) + errorCode heuristics and **skip** them — minting a repo incident for an EAS outage is a false divergence. When in doubt, prefer the app-node + log attach over a specific ConfigNode.
2. **Dirty-tree honesty.** If `isGitWorkingTreeDirty`, tag the incident lower-confidence and note the commit may not represent what built.
3. **Undocumented API → fail loud, not silent.** Pin the query; on a GraphQL schema/shape error, surface a clear connector error (the drift signal), don't silently drop builds.
4. **Logs: fetch-and-cap.** `logFileUrls` are time-limited and can be large (Xcode ~10MB) — fetch on poll, store a size-capped slice (enough for root cause), reference the rest.
5. **errorCode is free-text** — stable classifiers are `status` + `buildPhase` only.

## Module shape (follow `connectors/cloud-run/`)

`packages/core/src/connectors/eas/{client,resolve,map,index,types}.ts`:
- `client.ts` — the GraphQL POST + Bearer auth + paginated `builds(status: ERRORED)` fetch + `logFileUrls` download.
- `resolve.ts` — `buildPhase` → affectedNode resolution (the table above), through the fused-node lookup.
- `map.ts` — build failure → incident event (firebase precedent).
- `index.ts` / `types.ts` — connector entry + the EAS build shape.

**Register** in `connectors-config.ts` + `connectors/registry.ts`. **Config** (per `connector-config.md` contract): `EXPO_TOKEN` (robot user), the Expo **app** (slug or `projectId`), poll cadence. Pull-shape (Railway/Cloud-Run mold).

## Contract-first (before code)

Amend **`docs/contracts/connectors.md`** — add the `eas` provider: pull-shape, **incident-emitting**, **commit-grain** (not the route-grain the request-log connectors use), the transient-failure exclusion, OBSERVED provenance. Amend **`docs/contracts/connector-config.md`** — the `eas` config block (token + app id + cadence). Contract lands in the same PR, before/with the code.

## Explicitly NOT in v1 (deferred / non-goals)

- No native-log parsing into `file:line` (the "ambitious" tier — fuzzy Gradle/Xcode output; revisit only as far as structured data reliably supports).
- No EAS **Update** or **Submit** domains — Build only.
- No auto-fix — NEAT surfaces; the agent fixes.

## Test plan

Fixture EAS GraphQL responses → connector → assert:
- `ERRORED @ INSTALL_DEPENDENCIES` (commit + logs) → incident on the `package.json` ConfigNode, OBSERVED, carrying phase/commit/logs.
- `ERRORED @ READ_EAS_JSON` → incident on `eas.json` ConfigNode.
- `ERRORED @ RUN_GRADLEW` → incident on the **app node** + logs attached (no ConfigNode misattribution).
- `ERRORED @ SPIN_UP_BUILDER` / `INTERNAL_SERVER_ERROR`-class → **nothing minted** (transient filter holds).
- Fusion assertion: the config-phase incident's `affectedNode` is a node the **extractor** produced for the same fixture repo (ConfigNode for `app.json`/`eas.json`), i.e. it fuses, not twins — mirror `two-sided-observed.test.ts`.
- Pagination/dedupe: two pages with an overlapping build `id` → ingested once.

## ADR-185 (draft — appended to `docs/decisions.md`)

**Title:** EAS build failures as OBSERVED, commit-grain incidents on the repo.

NEAT pulls `ERRORED` EAS builds from the Expo GraphQL API and mints OBSERVED build-failure incidents anchored to the commit the build ran (`gitCommitHash`) and, where `error.buildPhase` allows, to the specific repo node that failed — `package.json`/`app.json`/`eas.json` ConfigNodes for the config/dependency phases, the app node with logs attached for native-compile phases. `buildPhase` (a strict enum) and `status` are the stable classifiers; `errorCode` is free-text and treated as a hint. Infra/credentials/transient phases are excluded so an EAS outage never mints a repo divergence. This extends the pull-connector family (Railway/Cloud-Run/Render) to a new grain: those fuse request logs onto RouteNodes (route-grain); EAS fuses build failures onto the repo (commit-grain), reusing the incident model (`get_incident_history`/`get_root_cause`) and the firebase connector's incident-emission path. The Expo GraphQL API is undocumented/unversioned, so the query set is pinned and schema drift fails loud. v1 does not parse native build logs into `file:line`, and covers Build only (not Update/Submit).
