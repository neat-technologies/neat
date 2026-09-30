"""The core proof: the processor stamps the caller's file:line onto a
CLIENT span, and leaves INTERNAL spans (and the SDK's own frames) alone."""

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import SpanKind

import neat_otel


def _make_provider():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(neat_otel.NeatCallSiteSpanProcessor())
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider, exporter


def _issue_client_span(tracer):
    with tracer.start_as_current_span("outbound", kind=SpanKind.CLIENT):
        pass


def test_stamps_client_span_with_caller_file_line():
    provider, exporter = _make_provider()
    tracer = provider.get_tracer("test")
    _issue_client_span(tracer)
    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    attrs = spans[0].attributes
    assert attrs["code.file.path"].endswith("test_processor.py")
    assert attrs["code.function.name"] == "_issue_client_span"
    assert isinstance(attrs["code.line.number"], int) and attrs["code.line.number"] > 0


def test_leaves_internal_spans_alone():
    provider, exporter = _make_provider()
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span("work", kind=SpanKind.INTERNAL):
        pass
    attrs = exporter.get_finished_spans()[0].attributes or {}
    assert "code.file.path" not in attrs


def test_disabled_by_env(monkeypatch):
    # The processor itself always stamps; the env gate lives on register().
    monkeypatch.setenv("NEAT_CALLSITE_DISABLED", "1")
    # Fresh module-level flag would be needed for a true register() test; here we
    # assert the gate is read by register (see test_delivery for the live path).
    import importlib

    importlib.reload(neat_otel)
    assert neat_otel.register() is False
