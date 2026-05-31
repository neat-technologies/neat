# Installer scope

`neat init` installs OTel deterministically for the following runtimes and frameworks:

**Node.js** — Express, Fastify, Koa, raw HTTP  
**Next.js** — Pages + App Router, Webpack + Turbopack, flat and src/ layouts  
**Remix** — v2+  
**SvelteKit** — adapter-node  
**Nuxt** — Nuxt 3  
**Astro** — @astrojs/node adapter  
**Python** — Flask, FastAPI, Django

## Manual setup for out-of-scope runtimes

For runtimes NEAT can't instrument deterministically, configure your OTel exporter to point at the NEAT receiver and it will pick up spans automatically.

### Bun

Install `@opentelemetry/sdk-bun` (or the standard Node SDK with `--bun` flag) and configure:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/projects/<your-project>/v1/traces
OTEL_SERVICE_NAME=<your-service>
```

### Deno

Use `@opentelemetry/sdk-node` via npm compatibility or `npm:@opentelemetry/sdk-node`. Set:

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/projects/<your-project>/v1/traces
OTEL_SERVICE_NAME=<your-service>
```

### Cloudflare Workers

Use the Cloudflare OTel binding or `@microlabs/otel-cf-workers`. Export to:

```
http://localhost:4318/projects/<your-project>/v1/traces
```

Workers can't reach localhost in production — use NEAT's hosted receiver URL there.

### AWS Lambda (ADOT)

Use the AWS Distro for OpenTelemetry (ADOT) Lambda layer. Configure `OTEL_EXPORTER_OTLP_ENDPOINT` to point at NEAT's receiver.

### Vercel Edge Functions / React Native / Electron

Bring your own OTel SDK and export spans to NEAT's receiver as above.

## Promoting a runtime to in-scope

A runtime moves to in-scope when: (a) 10+ users requesting it or top-20 npm framework rank; (b) a stable OTel pattern across two minor versions; (c) a fixture + contract assertions + CI smoke land alongside. Open an issue to start the conversation.
