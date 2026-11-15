"""Celery handler-entry and queue edges: stamp the CONSUMER span a worker runs
a task under, and name the messaging system on celery PRODUCER/CONSUMER spans."""

from __future__ import annotations

from opentelemetry import trace as _neat_trace
from opentelemetry.trace import SpanKind as _NeatSpanKind

from ._handler import _neat_endpoint_location, _neat_stamp_server


def _neat_celery_task_location(task):
    fn = getattr(task, "run", None)
    if fn is None:
        return None
    location = _neat_endpoint_location(fn)
    if location is None:
        return None
    return (location[0], location[1], getattr(task, "name", None) or location[2])

def _neat_celery_messaging(span, task=None):
    """Give a celery PRODUCER/CONSUMER span the messaging pair NEAT keys a
    queue edge on. The celery instrumentation sets the destination (the
    queue / routing key) but no messaging.system, and on the worker side the
    destination only when the delivery carried one. The system is ``celery``;
    a missing consumer destination comes from the delivery's routing key and
    is never guessed.
    """
    try:
        if span is None or not span.is_recording():
            return
        if getattr(span, "kind", None) not in (_NeatSpanKind.PRODUCER, _NeatSpanKind.CONSUMER):
            return
        attrs = getattr(span, "attributes", None) or {}
        if not attrs.get("messaging.system"):
            span.set_attribute("messaging.system", "celery")
        if not attrs.get("messaging.destination") and task is not None:
            info = getattr(getattr(task, "request", None), "delivery_info", None) or {}
            routing_key = info.get("routing_key") if isinstance(info, dict) else None
            if routing_key:
                span.set_attribute("messaging.destination", routing_key)
                span.set_attribute("messaging.destination_kind", "queue")
    except Exception:
        pass  # never break the app

def _neat_celery_publish_span(kwargs, late=False):
    if not late:
        return _neat_trace.get_current_span()
    from opentelemetry.instrumentation.celery import utils as _celery_utils

    task = _celery_utils.retrieve_task_from_sender(kwargs)
    task_id = _celery_utils.retrieve_task_id_from_message(kwargs)
    ctx = _celery_utils.retrieve_context(task, task_id, is_publish=True) if task_id else None
    return ctx[0] if ctx else None

def _neat_celery_before_publish(*_args, **kwargs):
    """The PRODUCER span is current here when this receiver runs after the
    instrumentation's before_task_publish receiver (the opentelemetry-instrument
    order)."""
    try:
        _neat_celery_messaging(_neat_celery_publish_span(kwargs))
    except Exception:
        pass

def _neat_celery_after_publish(*_args, **kwargs):
    """Fallback when NEAT registered first: the instrumentation ends the
    PRODUCER span in its own after_task_publish receiver, which then runs
    after this one, so the span is still recording here."""
    try:
        _neat_celery_messaging(_neat_celery_publish_span(kwargs, late=True))
    except Exception:
        pass

def _neat_celery_prerun(sender=None, task=None, **_kwargs):
    """Stamp the CONSUMER span a celery worker runs a task under.

    The celery instrumentation opens that span in its own task_prerun
    receiver and makes it current; the stack there is celery's worker loop,
    so the stack walk finds no application frame. Under
    opentelemetry-instrument this receiver is connected after the
    instrumentation's (instrumentors apply before the post-instrument entry
    point, and signals dispatch in connection order), so the span is current
    here. The task's own function is the location.
    """
    try:
        location = _neat_celery_task_location(task or sender)
        if location is not None:
            _neat_stamp_server(*location, kinds=(_NeatSpanKind.CONSUMER,))
        _neat_celery_messaging(_neat_trace.get_current_span(), task or sender)
    except Exception:
        pass  # never break the worker

def _neat_celery_postrun(sender=None, task_id=None, task=None, **_kwargs):
    """Fallback when this receiver was connected before the instrumentation
    (an app that instruments celery by hand after NEAT registered): prerun
    ran before the span existed, but postrun runs before the instrumentation
    ends it, so the span is still recording. It's read from the per-task
    context the instrumentation keeps.
    """
    try:
        task = task or sender
        from opentelemetry.instrumentation.celery import utils as _celery_utils

        ctx = _celery_utils.retrieve_context(task, task_id)
        span = ctx[0] if ctx else None
        if span is None or not span.is_recording():
            return
        if getattr(span, "kind", None) is not _NeatSpanKind.CONSUMER:
            return
        _neat_celery_messaging(span, task)
        if span.attributes and span.attributes.get("code.file.path"):
            return
        location = _neat_celery_task_location(task)
        if location is None:
            return
        span.set_attribute("code.file.path", location[0])
        span.set_attribute("code.line.number", location[1])
        span.set_attribute("code.function.name", location[2])
    except Exception:
        pass  # never break the worker

def _neat_patch_celery() -> None:
    try:
        from celery import signals
    except Exception:
        return
    signals.task_prerun.connect(_neat_celery_prerun, weak=False, dispatch_uid="neat-otel-task-entry")
    signals.task_postrun.connect(_neat_celery_postrun, weak=False, dispatch_uid="neat-otel-task-entry-late")
    signals.before_task_publish.connect(_neat_celery_before_publish, weak=False, dispatch_uid="neat-otel-publish")
    signals.after_task_publish.connect(_neat_celery_after_publish, weak=False, dispatch_uid="neat-otel-publish-late")
