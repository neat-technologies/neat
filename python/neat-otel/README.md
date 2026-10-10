# neat-otel

Runtime-attachment call-site attribution for [NEAT](https://neat.is).

`neat-otel` stamps the stable OpenTelemetry code attributes
(`code.file.path` / `code.line.number` / `code.function.name`) onto your
CLIENT / PRODUCER / SERVER spans, so NEAT can fuse a runtime span onto the
exact source file and line that issued it — at symbol grain.

It changes **no code**. You run your app under the standard OpenTelemetry
auto-instrumentation runner, and `neat-otel` loads its span processor through
the `opentelemetry_post_instrument` entry point:

```bash
pip install neat-otel
opentelemetry-bootstrap -a install          # instrumentations for your libraries
opentelemetry-instrument python app.py      # or: opentelemetry-instrument uvicorn app:app
```

That's it — no import, no edit to your entry point. Point NEAT's OTLP endpoint
at your app the usual way (`OTEL_EXPORTER_OTLP_ENDPOINT`), run it, and the
spans arrive already carrying their call site.

## If you configure OpenTelemetry yourself

If you don't use `opentelemetry-instrument`, add the processor once, after your
tracer provider is set up:

```python
import neat_otel
neat_otel.register()
```

`register()` is idempotent and attaches to the active tracer provider.

## Notes

- **Fork-safe.** The processor is synchronous and holds no background thread,
  so gunicorn / uvicorn pre-fork workers inherit it without a post-fork hook.
- **Fails safe.** If OpenTelemetry isn't installed, or a frame can't be read,
  it degrades to a no-op rather than breaking your app.
- **SERVER spans stay route-grained.** A framework SERVER span is created
  before your handler runs, so it isn't attributed to a handler line — that's
  honest; the outbound CLIENT/PRODUCER spans your code issues carry the call
  site.
- Turn it off with `NEAT_CALLSITE_DISABLED=1`.

## Grain

`neat-otel` is the Python half of NEAT's attachment-first instrumentation
(ADR-232): symbol-grain runtime fusion, delivered without editing your source.

## License

Apache-2.0
