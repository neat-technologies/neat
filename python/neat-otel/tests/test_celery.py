"""Real-framework proof for celery: a task run by the worker path executes under
the instrumentation's CONSUMER span, and that span must carry the task
function's own code location, with no edit to the task.
"""

import inspect

import pytest

pytest.importorskip("celery")
pytest.importorskip("opentelemetry.instrumentation.celery")

from celery import Celery
from opentelemetry.instrumentation.celery import CeleryInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

import neat_otel

EXPORTER = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(EXPORTER))

app = Celery("neat_celery_test", broker="memory://", backend="cache+memory://")
app.conf.task_always_eager = True


@app.task
def consume_document(doc_id):
    return doc_id * 2


@pytest.fixture(autouse=True)
def _instrumented():
    neat_otel.register()
    CeleryInstrumentor().instrument(tracer_provider=_provider)
    EXPORTER.clear()
    yield
    CeleryInstrumentor().uninstrument()


def test_task_consumer_span_carries_the_task_location():
    assert consume_document.apply(args=(21,)).get() == 42
    spans = [s for s in EXPORTER.get_finished_spans() if s.kind == SpanKind.CONSUMER]
    assert len(spans) == 1, [(s.name, s.kind) for s in EXPORTER.get_finished_spans()]
    attrs = spans[0].attributes
    assert attrs.get("code.file.path") == inspect.getsourcefile(consume_document.run)
    assert attrs.get("code.line.number") == inspect.getsourcelines(consume_document.run)[1]
    assert attrs.get("code.function.name") == consume_document.name


def test_stamped_on_prerun_when_connected_after_the_instrumentation():
    # The opentelemetry-instrument order: instrumentors first, NEAT after.
    from celery import signals

    signals.task_prerun.disconnect(dispatch_uid="neat-otel-task-entry")
    signals.task_postrun.disconnect(dispatch_uid="neat-otel-task-entry-late")
    neat_otel._neat_patch_celery()
    EXPORTER.clear()
    assert consume_document.apply(args=(1,)).get() == 2
    span = next(s for s in EXPORTER.get_finished_spans() if s.kind == SpanKind.CONSUMER)
    assert span.attributes.get("code.function.name") == consume_document.name
    assert span.attributes.get("code.line.number") == inspect.getsourcelines(consume_document.run)[1]


def _publish_and_get_producer():
    app.conf.task_always_eager = False
    try:
        EXPORTER.clear()
        consume_document.apply_async(args=(3,), queue="documents")
        return next(s for s in EXPORTER.get_finished_spans() if s.kind == SpanKind.PRODUCER)
    finally:
        app.conf.task_always_eager = True


def test_producer_span_names_the_messaging_system_and_queue():
    # NEAT connected first here (register() before instrument()): the
    # after_task_publish fallback fills it while the span is still open.
    span = _publish_and_get_producer()
    assert span.attributes.get("messaging.system") == "celery"
    assert span.attributes.get("messaging.destination") == "documents"


def test_producer_filled_on_before_publish_when_connected_after_the_instrumentation():
    from celery import signals

    signals.before_task_publish.disconnect(dispatch_uid="neat-otel-publish")
    signals.after_task_publish.disconnect(dispatch_uid="neat-otel-publish-late")
    neat_otel._neat_patch_celery()
    span = _publish_and_get_producer()
    assert span.attributes.get("messaging.system") == "celery"


def test_consumer_span_names_the_messaging_system():
    consume_document.apply(args=(4,))
    span = next(s for s in EXPORTER.get_finished_spans() if s.kind == SpanKind.CONSUMER)
    assert span.attributes.get("messaging.system") == "celery"


def test_consumer_destination_comes_from_the_delivery_routing_key():
    class _Req:
        delivery_info = {"routing_key": "documents"}

    class _Task:
        request = _Req()

    tracer = _provider.get_tracer("t")
    with tracer.start_as_current_span("run/x", kind=SpanKind.CONSUMER) as span:
        neat_otel._neat_celery_messaging(span, _Task())
    finished = [s for s in EXPORTER.get_finished_spans() if s.name == "run/x"][-1]
    assert finished.attributes.get("messaging.destination") == "documents"
    assert finished.attributes.get("messaging.system") == "celery"
