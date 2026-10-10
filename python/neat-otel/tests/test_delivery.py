"""The delivery proof: the ``opentelemetry_post_instrument`` entry point is
registered, and the hook attaches the processor to whatever provider the runner
set up — so nothing in the user's app imports or configures anything."""

import importlib

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import SpanKind


def test_entry_point_is_registered():
    from importlib.metadata import entry_points

    eps = entry_points(group="opentelemetry_post_instrument")
    assert "neat" in {ep.name for ep in eps}


def test_hook_attaches_to_global_provider():
    import neat_otel

    importlib.reload(neat_otel)  # reset the one-time _NEAT_REGISTERED guard

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    # Simulate the runner's configurator setting the global provider before the
    # app runs (set-once guard is bypassed for the test).
    trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
    trace.set_tracer_provider(provider)

    # What opentelemetry-instrument invokes through the entry point:
    neat_otel.neat_post_instrument()

    tracer = trace.get_tracer("app")
    with tracer.start_as_current_span("outbound", kind=SpanKind.CLIENT):
        pass

    attrs = exporter.get_finished_spans()[0].attributes
    assert attrs["code.file.path"].endswith("test_delivery.py")
    assert attrs["code.function.name"] == "test_hook_attaches_to_global_provider"
