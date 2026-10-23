# e2e/phase0 — the Phase 0 acceptance gate

The project-model rebuild (ADR-273, [docs/contracts/project-identity.md](../../docs/contracts/project-identity.md)) is done when the Newdryve install roadbumps are gone. This harness states each one as an assertion against a local build: what a user types, and what NEAT must and must not say back.

```bash
npx turbo build --filter=@neat.is/core... --filter=@neat.is/mcp...
./e2e/phase0/run.sh          # exit code = number of failing cases
```

It runs in a throwaway `NEAT_HOME` with four throwaway repos and a fake hosted profile pointing at a closed port, so it never reads `~/.neat`, never reaches a hosted account, and anything that leaks to "hosted" shows up as a probe of `127.0.0.1:9`. Daemons it starts are paused at the end. `CORE` / `MCP` override the package directories.

| case | roadbump | asserts |
|---|---|---|
| 0 | #1 | a fresh `npm i` of `@neat.is/core` pulls nothing that needs Node > 20 and prints no EBADENGINE (needs the registry; SKIP offline) |
| 1 | identity | `neat init` writes a `prj_<ULID>` and a local binding; re-init keeps the id |
| 2 / 2b | pre-ADR-273 repo | a legacy registration gets the "run `neat init`" notice from the CLI and from an MCP tool, even with its daemon down |
| 3 | resolution | outside any project, a query errors with "no NEAT project here", never a `default` |
| 4 | #11 | `neat up` on a hosted-bound project exits non-zero with the honest message, no "Ready" |
| 5 | #11 | logged in to hosted, a local project's query goes to its local daemon |
| 6a/b/c | #7 | the binding line rides the daemon's `neat-binding` header, an MCP tool result, and `neat://status` |
| 8 | #4 | a connector added in repoA is absent from repoB's `neat connector list` |
| 9 / 9b | #5 | a connector with an unset `$TOKEN` is named by `neat up` and fails `neat doctor` |
| 10t | #10 | a token piped to `neat connector add --token-stdin` ends up in the OS keychain and nowhere else; the project file holds `keychain:neat/<provider>/<projectId>` (macOS, a throwaway keychain; SKIP elsewhere) |
| 11 | coexistence | two local projects and a hosted-bound one resolve to their own targets in one shell |
| 12 | #9 | `neat init` on a workspaces root that is also the app (Newdryve's Expo client beside a `backend` workspace) discovers both services |

Cases 7 (`neat list` segmentation) and 10 (orphaned MCP servers) are covered by `packages/core/test/registry-index.test.ts`.
