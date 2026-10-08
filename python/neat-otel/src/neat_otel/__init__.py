"""neat-otel — runtime-attachment call-site attribution for NEAT.

Stamps the stable OpenTelemetry code attributes (``code.file.path`` /
``code.line.number`` / ``code.function.name``, semconv >=1.33) on
CLIENT / PRODUCER / SERVER spans by walking the stack to the first
application frame, so NEAT fuses a runtime span onto the source file that
issued it (file-awareness.md section 4, ADR-151).

Delivery is by *attachment* (ADR-232) — no source edit. Run your app under
the standard auto-instrumentation runner and NEAT's processor loads itself
through the ``opentelemetry_post_instrument`` entry point:

    pip install neat-otel
    opentelemetry-instrument python app.py          # or uvicorn/gunicorn app:app

Nothing is imported or added to your code. If you configure OpenTelemetry
yourself, call ``neat_otel.register()`` after your provider is set up.

If OpenTelemetry is absent the module degrades to a no-op rather than
breaking the host app (the ADR-144 discipline). Set
``NEAT_CALLSITE_DISABLED=1`` to turn the processor off.
"""

from __future__ import annotations

import os
import sys

try:
    from opentelemetry import trace as _neat_trace
    from opentelemetry.sdk.trace import SpanProcessor as _NeatSpanProcessor
    from opentelemetry.trace import SpanKind as _NeatSpanKind

    _NEAT_OTEL = True
except Exception:  # pragma: no cover - OTel not installed
    _NEAT_OTEL = False

__all__ = ["register", "neat_post_instrument", "NeatCallSiteSpanProcessor"]

_NEAT_REGISTERED = False


if _NEAT_OTEL:
    _NEAT_SELF = os.path.abspath(__file__)
    _NEAT_PREFIXES = tuple(
        os.path.abspath(p) + os.sep
        for p in {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix}
    )
    _NEAT_KINDS = {_NeatSpanKind.CLIENT, _NeatSpanKind.PRODUCER, _NeatSpanKind.SERVER}

    def _neat_is_user_frame(filename: str) -> bool:
        if not filename:
            return False
        if filename.startswith("<") and filename.endswith(">"):
            return False
        abs_name = os.path.abspath(filename)
        if abs_name == _NEAT_SELF:
            return False
        parts = abs_name.split(os.sep)
        if "opentelemetry" in parts or "site-packages" in parts:
            return False
        for pref in _NEAT_PREFIXES:
            if abs_name.startswith(pref):
                return False
        return True

    class NeatCallSiteSpanProcessor(_NeatSpanProcessor):  # type: ignore[misc, valid-type]
        """Stamps the call site's ``code.*`` onto CLIENT/PRODUCER/SERVER spans.

        ``on_start`` is synchronous and holds no background thread, so it is
        safe across a ``fork()`` (gunicorn/uvicorn pre-fork workers inherit it).
        """

        def on_start(self, span, parent_context=None):
            try:
                if span.kind not in _NEAT_KINDS:
                    return
                frame = sys._getframe(1)
                while frame is not None:
                    if _neat_is_user_frame(frame.f_code.co_filename):
                        span.set_attribute(
                            "code.file.path", os.path.abspath(frame.f_code.co_filename)
                        )
                        span.set_attribute("code.line.number", frame.f_lineno)
                        span.set_attribute("code.function.name", frame.f_code.co_name)
                        return
                    frame = frame.f_back
            except Exception:
                pass  # never break the host application

        def on_end(self, span):
            pass

        def shutdown(self):
            pass

        def force_flush(self, timeout_millis: int = 30000):
            return True

    def register() -> bool:
        """Add the call-site processor to the active tracer provider, once.

        Returns True if the processor was added (or already present), False if
        the provider does not accept span processors yet (e.g. the default
        no-op provider before the SDK is configured).
        """
        global _NEAT_REGISTERED
        if _NEAT_REGISTERED:
            return True
        if os.environ.get("NEAT_CALLSITE_DISABLED", "") == "1":
            return False
        try:
            provider = _neat_trace.get_tracer_provider()
            add = getattr(provider, "add_span_processor", None)
            if callable(add):
                add(NeatCallSiteSpanProcessor())
                _NEAT_REGISTERED = True
                return True
        except Exception:
            pass
        return False

else:  # pragma: no cover - OTel not installed: everything is a no-op

    class NeatCallSiteSpanProcessor:  # type: ignore[no-redef]
        pass

    def register() -> bool:
        return False


def neat_post_instrument(*_args, **_kwargs) -> None:
    """Entry point invoked by ``opentelemetry-instrument`` after the SDK
    provider is configured and the instrumentors are applied. This is the
    zero-source-edit delivery: the runner loads it via the
    ``opentelemetry_post_instrument`` entry point (see pyproject.toml).
    """
    register()
