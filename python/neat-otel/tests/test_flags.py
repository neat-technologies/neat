"""Flag evaluations under the preload: with openfeature-sdk installed, each
evaluation lands as a ``feature_flag.evaluation`` event on the span active at
the time, in the semconv shape NEAT's ingest reads. Skipped without the SDK."""

import pytest

pytest.importorskip("openfeature.api")

from openfeature import api  # noqa: E402
from openfeature.provider.in_memory_provider import InMemoryFlag, InMemoryProvider  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)
from opentelemetry.trace import SpanKind  # noqa: E402

import neat_otel  # noqa: E402


@pytest.fixture()
def tracer():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    api.clear_hooks()
    neat_otel._NEAT_FLAG_HOOKED = False
    assert neat_otel.attach_flag_hook()
    api.set_provider(
        InMemoryProvider(
            {
                "cartFailure": InMemoryFlag("on", {"on": True, "off": False}),
                "context": InMemoryFlag("a", {"a": {"nested": 1}}),
            }
        )
    )
    yield provider.get_tracer("app"), exporter
    api.clear_hooks()


def events(exporter):
    (span,) = exporter.get_finished_spans()
    return [(e.name, dict(e.attributes)) for e in span.events]


def test_records_a_successful_evaluation_on_the_active_span(tracer):
    t, exporter = tracer
    with t.start_as_current_span("GET /cart", kind=SpanKind.SERVER):
        assert api.get_client().get_boolean_value("cartFailure", False) is True
    assert events(exporter) == [
        (
            "feature_flag.evaluation",
            {
                "feature_flag.key": "cartFailure",
                "feature_flag.provider.name": "In-Memory Provider",
                "feature_flag.result.variant": "on",
                "feature_flag.result.reason": "static",
                "feature_flag.result.value": "true",
            },
        )
    ]


def test_records_an_errored_evaluation_with_the_code_default(tracer):
    t, exporter = tracer
    with t.start_as_current_span("GET /cart", kind=SpanKind.SERVER):
        assert api.get_client().get_string_value("noSuchFlag", "dflt") == "dflt"
    ((name, attrs),) = events(exporter)
    assert name == "feature_flag.evaluation"
    assert attrs["error.type"] == "flag_not_found"
    assert attrs["feature_flag.result.reason"] == "error"
    assert attrs["feature_flag.result.value_type"] == "string"
    assert "feature_flag.result.value" not in attrs


def test_skips_object_values_and_never_records_the_evaluation_context(tracer):
    from openfeature.evaluation_context import EvaluationContext

    t, exporter = tracer
    with t.start_as_current_span("GET /cart", kind=SpanKind.SERVER):
        api.get_client().get_object_value(
            "context", {}, EvaluationContext("user-42", {"email": "a@b.c"})
        )
    ((_, attrs),) = events(exporter)
    assert "feature_flag.result.value" not in attrs
    assert "user-42" not in repr(attrs) and "a@b.c" not in repr(attrs)


def test_no_span_in_scope_records_nothing_and_still_evaluates(tracer):
    _, exporter = tracer
    assert api.get_client().get_boolean_value("cartFailure", False) is True
    assert exporter.get_finished_spans() == ()


def test_hook_is_added_once():
    api.clear_hooks()
    neat_otel._NEAT_FLAG_HOOKED = False
    assert neat_otel.attach_flag_hook() and neat_otel.attach_flag_hook()
    assert len(api.get_hooks()) == 1
    api.clear_hooks()


def test_records_a_string_result_by_type_never_the_string():
    class Ctx:
        flag_key = "dbUrl"
        provider_metadata = None

    class Details:
        value = "postgres://app:hunter2@db/orders"
        variant = "primary"
        reason = "STATIC"

    assert neat_otel.neat_flag_event_attributes(Ctx(), Details()) == {
        "feature_flag.key": "dbUrl",
        "feature_flag.result.variant": "primary",
        "feature_flag.result.reason": "static",
        "feature_flag.result.value_type": "string",
    }
