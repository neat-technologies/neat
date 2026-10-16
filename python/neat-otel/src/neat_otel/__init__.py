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
_NEAT_HANDLER_PATCHED = False


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

    def _neat_stamp_server(filepath: str, lineno: int, name: str) -> None:
        """Stamp the active SERVER span with a handler's own code location.

        The CLIENT/PRODUCER stack walk can't reach the inbound handler: the
        framework opens the SERVER span in ASGI/WSGI middleware before the
        handler runs, so there is no application frame on the stack yet. The
        handler-entry wrap calls this once the handler is actually running, when
        that span is the current one.
        """
        try:
            span = _neat_trace.get_current_span()
            if getattr(span, "kind", None) is not _NeatSpanKind.SERVER:
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

    def _neat_wrap_endpoint(endpoint):
        """Wrap a route handler so it stamps the SERVER span when it runs.

        The wrap preserves the endpoint's signature (FastAPI reads it for
        dependency injection) and its sync/async nature, and degrades to the
        original on any trouble so it can never break the app.
        """
        try:
            import inspect
            from functools import wraps

            if getattr(endpoint, "__neat_handler__", False):
                return endpoint
            location = _neat_endpoint_location(endpoint)
            if location is None:
                return endpoint

            if inspect.iscoroutinefunction(endpoint):

                @wraps(endpoint)
                async def wrapper(*args, **kwargs):
                    _neat_stamp_server(*location)
                    return await endpoint(*args, **kwargs)

            else:

                @wraps(endpoint)
                def wrapper(*args, **kwargs):
                    _neat_stamp_server(*location)
                    return endpoint(*args, **kwargs)

            wrapper.__neat_handler__ = True
            return wrapper
        except Exception:
            return endpoint

    def _neat_patch_fastapi() -> None:
        try:
            from fastapi import routing as fastapi_routing
        except Exception:
            return
        router = fastapi_routing.APIRouter
        if getattr(router.add_api_route, "__neat_patched__", False):
            return
        original = router.add_api_route

        def add_api_route(self, path, endpoint, *args, **kwargs):
            return original(self, path, _neat_wrap_endpoint(endpoint), *args, **kwargs)

        add_api_route.__neat_patched__ = True
        router.add_api_route = add_api_route

    def _neat_patch_flask() -> None:
        try:
            from flask import Flask
        except Exception:
            return
        if getattr(Flask.add_url_rule, "__neat_patched__", False):
            return
        original = Flask.add_url_rule

        def add_url_rule(self, rule, endpoint=None, view_func=None, *args, **options):
            if view_func is not None:
                view_func = _neat_wrap_endpoint(view_func)
            return original(self, rule, endpoint, view_func, *args, **options)

        add_url_rule.__neat_patched__ = True
        Flask.add_url_rule = add_url_rule

    def _neat_install_handler_entry() -> None:
        """Patch FastAPI/Flask route registration so a handler stamps its own
        SERVER span. Patched once, on the classes, before the app module is
        imported under ``opentelemetry-instrument`` — so routes defined later are
        covered. Each framework is independent and guarded; a missing one is a
        silent skip. Django is a follow-up.
        """
        global _NEAT_HANDLER_PATCHED
        if _NEAT_HANDLER_PATCHED:
            return
        _NEAT_HANDLER_PATCHED = True
        _neat_patch_fastapi()
        _neat_patch_flask()

    def register() -> bool:
        """Add the call-site processor to the active tracer provider, once, and
        install the handler-entry attribution for SERVER spans.

        Returns True if the processor was added (or already present), False if
        the provider does not accept span processors yet (e.g. the default
        no-op provider before the SDK is configured).
        """
        global _NEAT_REGISTERED
        if _NEAT_REGISTERED:
            return True
        if os.environ.get("NEAT_CALLSITE_DISABLED", "") == "1":
            return False
        # SERVER-span attribution patches the framework, not the provider, so it
        # is installed even if the SDK provider is not ready on this call.
        _neat_install_handler_entry()
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
