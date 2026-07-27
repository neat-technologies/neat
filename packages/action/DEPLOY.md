# Deploying the NEAT GitHub App

The App (`src/app.mjs`) is the stateful, zero-config-install form of the Action:
users install it on a repo in two clicks, it receives `pull_request` webhooks,
and it posts the same graph-impact comment. Because it is a persistent service,
it is also the natural **connected NEAT host** the Action's fused tier
(`neat-api-url`) points at.

The App's security + wiring core (webhook signature verification, App JWT auth,
event routing, comment posting) is built and tested (`test/app.test.mjs`). What
remains is **operational** and needs GitHub-org admin + a public host — it can't
be done from CI. Steps:

## 1. Register the App (org admin)

Org **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Webhook URL**: the public URL of the deployed server (step 3), `+ /webhook`.
- **Webhook secret**: a random secret (used to verify each delivery).
- **Permissions**: `Pull requests: Read & write`, `Contents: Read-only`.
- **Subscribe to events**: `Pull request`.

Save, then generate a **private key** (PEM). Note the **App ID**.

## 2. Provide `computeImpact`

The handler is injected with `computeImpact({ owner, repo, prNumber, baseSha,
headSha, token, cloneUrl })`, which must return `{ graph, delta, changedFiles,
divergences }`. Reuse the Action's flow: clone `cloneUrl` with the installation
`token`, check out `baseSha` and `headSha`, extract each with the NEAT engine,
then `diffGraphs` / `blastRadius` (exactly `src/main.mjs`, minus the CI-supplied
checkout). For the fused divergences, query the App's own persistent graph.

## 3. Deploy

Any host that runs Node 20 and exposes a public HTTPS URL (Fly, Render, Cloud
Run). No build step — `src/app.mjs` is zero-dependency. Environment:

```
APP_ID=<from step 1>
PRIVATE_KEY=<the PEM, or a path to it>
WEBHOOK_SECRET=<from step 1>
PORT=3000
```

Entry: import `startServer` from `src/app.mjs`, pass `{ secret, appId, privateKey,
computeImpact }`. Point the App's webhook URL (step 1) at `https://<host>/webhook`.

## 4. Install

Install the App on the target repos (org **Settings → GitHub Apps → Install**).
On the next PR, the App posts the graph-impact comment — no workflow file needed.

## Where the App and the Action meet

- The **Action** is self-serve, runs in the user's CI, free, static tier.
- The **App** is zero-config, stateful, and hosts the graph — so it doubles as
  the fused tier's `neat-api-url` host and is the surface for managed hosting +
  billing.

Both share the same `graph.mjs` logic; only the plumbing differs.
