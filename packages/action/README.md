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
| `neat-api-url` | `''` | Reserved for the fused tier — a connected NEAT host that weights the impact by production `OBSERVED` traffic. Not yet consumed. |

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
