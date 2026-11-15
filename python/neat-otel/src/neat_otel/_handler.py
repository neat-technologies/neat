"""Handler-entry helpers shared by neat-otel's framework patches: the code
location of a handler, and the stamp that puts it on the active SERVER (or
CONSUMER) span."""

from __future__ import annotations

import os

from opentelemetry import trace as _neat_trace
from opentelemetry.trace import SpanKind as _NeatSpanKind


def _neat_stamp_server(filepath: str, lineno: int, name: str, kinds=None) -> None:
    """Stamp the active SERVER span with a handler's own code location.

    The CLIENT/PRODUCER stack walk can't reach the inbound handler: the
    framework opens the SERVER span in ASGI/WSGI middleware before the
    handler runs, so there is no application frame on the stack yet. The
    handler-entry wrap calls this once the handler is actually running, when
    that span is the current one.
    """
    try:
        span = _neat_trace.get_current_span()
        if getattr(span, "kind", None) not in (kinds or (_NeatSpanKind.SERVER,)):
            return
        if not span.is_recording():
            return
        span.set_attribute("code.file.path", filepath)
        span.set_attribute("code.line.number", lineno)
        span.set_attribute("code.function.name", name)
    except Exception:
        pass  # never break the host application

def _neat_endpoint_location(endpoint):
    try:
        import inspect

        fn = inspect.unwrap(endpoint)
        code = getattr(fn, "__code__", None)
        if code is None:
            return None
        name = getattr(endpoint, "__name__", None) or code.co_name
        return (os.path.abspath(code.co_filename), code.co_firstlineno, name)
    except Exception:
        return None
