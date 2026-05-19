# Public-read reference deployment

How to bring up a NEAT instance whose dashboard is publicly readable while writes and OTel ingest stay token-gated. Targets `try.neat.is` — the reference deployment NEAT runs against the dogfood app (northsea today) so visitors land on a live graph with no auth dance.

The shape:

- One daemon container. `NEAT_PUBLIC_READ=true` + `NEAT_AUTH_TOKEN=<token>`.
- Reverse proxy terminates TLS at the public hostname. The dashboard sits behind the same proxy.
- The dogfooded app's OTel SDK ships spans to the daemon's OTLP receiver carrying the bearer.
- CI pushes static-graph snapshots through `neat sync --to https://try.neat.is --token $TOKEN`.

## 1. Run the daemon

```bash
docker run -d \
  --name neat \
  --restart=unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -p 127.0.0.1:4318:4318 \
  -p 127.0.0.1:6328:6328 \
  -v /var/lib/neat:/neat-out \
  -e NEAT_PUBLIC_READ=true \
  -e NEAT_AUTH_TOKEN=$NEAT_AUTH_TOKEN \
  -e NEAT_HOST=0.0.0.0 \
  ghcr.io/neat-technologies/neat:latest
```

Notes:

- Bind to `127.0.0.1` on the host. The reverse proxy below is the only thing that talks to the daemon. Public binding without a fronting proxy is not the supported shape.
- `NEAT_HOST=0.0.0.0` inside the container lets the reverse proxy reach the daemon; the host-side port map keeps it off the public interface.
- `NEAT_AUTH_TOKEN` is the write token. Generate once with `openssl rand -base64 32` and keep it in your secrets manager.

## 2. Front the daemon with Caddy

```caddyfile
try.neat.is {
    encode gzip
    reverse_proxy /api/* 127.0.0.1:8080
    reverse_proxy /events 127.0.0.1:8080
    reverse_proxy 127.0.0.1:6328
}

otlp.neat.is {
    reverse_proxy 127.0.0.1:4318
}
```

Caddy handles TLS via ACME automatically. The OTLP receiver lives on a separate subdomain so the bearer can't accidentally leak through the dashboard's HSTS context.

DNS:

- `try.neat.is` → host's public IP, port 443.
- `otlp.neat.is` → same host, port 443.

## 3. Wire the dogfooded app's OTel SDK

In the application that NEAT is graphing, set these env-vars on the deploy platform:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.neat.is
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${NEAT_AUTH_TOKEN}
OTEL_SERVICE_NAME=<service>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=prod
```

The OTel SDK reads `OTEL_EXPORTER_OTLP_HEADERS` and attaches the bearer on every export. The daemon's OTLP receiver validates it against `NEAT_AUTH_TOKEN` (or `NEAT_OTEL_TOKEN` if you rotated independently) before accepting any span — `NEAT_PUBLIC_READ` does not relax this.

## 4. Push static-graph snapshots from CI

Static extraction runs in CI on the dogfooded app's repo and ships the result to the public daemon:

```yaml
# .github/workflows/neat-sync.yml
on:
  push:
    branches: [main]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx neat.is sync . \
          --to https://try.neat.is \
          --token ${{ secrets.NEAT_AUTH_TOKEN }}
```

`neat sync` re-runs discovery + extraction locally and `POST`s the snapshot to `/snapshot` on the public daemon. The bearer goes on the same `Authorization` header — `/snapshot` is a write, so anonymous reads don't apply.

## 5. Smoke the deployment

```bash
# Anonymous GETs work — the dashboard is public.
curl -fsS https://try.neat.is/api/projects | jq

# /api/config advertises the mode.
curl -fsS https://try.neat.is/api/config
# {"publicRead":true,"authProxy":false}

# Writes refuse without the token.
curl -i -X POST https://try.neat.is/snapshot \
  -H 'content-type: application/json' \
  -d '{}'
# HTTP/1.1 401 Unauthorized

# With the token, writes go through.
curl -i -X POST https://try.neat.is/snapshot \
  -H "authorization: Bearer $NEAT_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"snapshot":{...}}'
```

## 6. Token rotation

Two rotation surfaces, independent on purpose:

- `NEAT_AUTH_TOKEN` rotates the REST write token. Update the container env, restart, refresh the CI secret, refresh the operator's local `neat sync --token` invocations.
- `NEAT_OTEL_TOKEN` rotates the OTLP bearer. Update the container env, restart, then bump `OTEL_EXPORTER_OTLP_HEADERS` on the dogfooded app. Web shell and `neat sync` are unaffected.

When only `NEAT_AUTH_TOKEN` is set, OTLP inherits it — that is the simple steady state. Setting `NEAT_OTEL_TOKEN` is a deliberate split for operators who need different rotation cadences on the two surfaces.

## What this deployment does **not** do

- It does not host the operator's actual codebase. The dogfooded app runs wherever the operator deploys it; only the OTel export endpoint points at NEAT.
- It does not write to the registry on visitor traffic. `~/.neat/projects.json` inside the container is shaped by `neat sync` from CI; visitor GETs leave it alone.
- It does not authenticate visitors. There is no concept of a "viewer" account. Anonymous read, token-bearing write. If you need per-user views, you need an upstream identity proxy and `NEAT_AUTH_PROXY=true` — that is a different shape than this runbook covers.
