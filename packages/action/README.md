# NEAT graph impact — GitHub Action

Puts NEAT's graph on the pull request. On every PR it extracts the base and head
graphs with the NEAT engine, diffs them, and posts a **sticky comment** with:

- **What changed in the graph** — routes, DB tables, and dependencies this PR adds
  or removes (a removed table reference is flagged ⚠️).
- **Blast radius** — for each changed file, what depends on it.

It runs entirely in the CI runner — no daemon, no hosting, no account. The
differentiated **fused tier** (impact weighted by production traffic, and
declared-vs-observed divergence) arrives when the action is pointed at a
connected NEAT host via `neat-api-url`.

## Usage

```yaml
name: NEAT
on: pull_request
permissions:
  pull-requests: write
  contents: read
jobs:
  graph-impact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the action diffs base…head and reads the base commit
      - uses: neat-technologies/neat-action@v0
```

## Inputs

| Input | Default | Notes |
|---|---|---|
| `github-token` | `${{ github.token }}` | Posts the PR comment; needs `pull-requests: write`. |
| `engine` | `neat.is` | The NEAT engine package run via `npx` to extract the graph. |
| `security` | `on` | Checks the PR for known vulnerabilities its code pulls in and posts them, with the fix, as a second sticky comment. `off` skips it. |
| `security-gate` | `report` | `report` only comments. `fail` also fails the check when the PR introduces a reachable known vulnerability. |
| `neat-api-url` | `''` | Reserved for the fused tier — a connected NEAT host that weights the impact by production `OBSERVED` traffic. Not yet consumed. |

## Security gate

On every PR the action also asks the engine which known vulnerabilities the
PR's code pulls in, comparing base and head against one advisory snapshot
(`neat security diff --base <sha> --head <sha> --json`). The comment lists what
the PR **introduces**, what it **removes**, and what was **already present**,
each with the advisory, the package and version, how exposed it is (imported,
reachable, or called in production), the fixed version, and the file and line
that import it. Packages that are only in the lockfile are context, never
findings.

The scan runs inline in CI; the advisory lookup is its one network call, so no
daemon is needed. An engine without the diff falls back to a head-only scan
(`neat security scan --json`), which lists what the head pulls in without
attributing it to the PR, and then to a connected host's
`/graph/security/reachable-cves` when `neat-api-url` is set.

By default the gate only comments. Set `security-gate: fail` to fail the check
when the PR introduces a reachable known vulnerability. A head-only scan never
fails the check, since it can't tell what the PR introduced.

## Example comment

> ### 🔷 NEAT — graph impact of this PR
>
> **What changed in the graph**
> - ➕ routes: `GET /orders/{order_id}/items`
> - ➖ routes: `GET /customers`
> - ➕ tables: `order_items`
> - ➖ tables: `customers`  ⚠️ removed reference — confirm nothing else still reads it
>
> **Blast radius**
> - `models.py` → depended on by `main.py`
>
> *Static graph (EXTRACTED). Set `neat-api-url` to weight this by production traffic (OBSERVED) and flag declared-vs-observed divergence.*
