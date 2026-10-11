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

If the app uses the OpenFeature SDK (``openfeature-sdk``), each flag
evaluation is also recorded as a ``feature_flag.evaluation`` event on the span
active at the time (OTel semconv), so a flag the app read rides along with the
service and call site that read it. The evaluation context is never recorded.

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
_NEAT_FLAG_HOOKED = False


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

    def _neat_set_value(attrs, value) -> None:
        # Boolean and number values are recorded. A string value can hold
        # config (a URL, a connection string), which never leaves the app, so
        # only its type is recorded; the variant names it. Objects are skipped.
        if isinstance(value, bool):
            attrs["feature_flag.result.value"] = "true" if value else "false"
        elif isinstance(value, (int, float)):
            attrs["feature_flag.result.value"] = str(value)
        elif isinstance(value, str):
            attrs["feature_flag.result.value_type"] = "string"

    def _neat_lower(value):
        value = getattr(value, "value", value)  # Reason / ErrorCode enums
        return str(value).lower() if value else None

    def neat_flag_event_attributes(hook_context, details=None, exception=None):
        """The ``feature_flag.evaluation`` event's attributes for one
        evaluation; ``exception`` set when it errored."""
        key = getattr(hook_context, "flag_key", None)
        if not isinstance(key, str) or not key:
            return None
        attrs = {"feature_flag.key": key}
        provider = getattr(getattr(hook_context, "provider_metadata", None), "name", None)
        if isinstance(provider, str) and provider:
            attrs["feature_flag.provider.name"] = provider
        if exception is not None:
            # An errored evaluation hands the caller its code default.
            attrs["error.type"] = _neat_lower(getattr(exception, "error_code", None)) or "general"
            attrs["feature_flag.result.reason"] = "error"
            _neat_set_value(attrs, getattr(hook_context, "default_value", None))
        else:
            variant = getattr(details, "variant", None)
            if isinstance(variant, str) and variant:
                attrs["feature_flag.result.variant"] = variant
            reason = _neat_lower(getattr(details, "reason", None))
            if reason:
                attrs["feature_flag.result.reason"] = reason
            _neat_set_value(attrs, getattr(details, "value", None))
        return attrs

    def _neat_record_flag(attrs) -> None:
        if not attrs:
            return
        span = _neat_trace.get_current_span()
        # No span in scope (a flag read at boot): nothing to attach it to.
        if span is None or not span.is_recording():
            return
        span.add_event("feature_flag.evaluation", attrs)

    def attach_flag_hook() -> bool:
        """Add the flag-evaluation hook to OpenFeature's global API, once.
        A no-op (False) when the app doesn't have ``openfeature-sdk``."""
        global _NEAT_FLAG_HOOKED
        if _NEAT_FLAG_HOOKED:
            return True
        try:
            import importlib.util

            if importlib.util.find_spec("openfeature.api") is None:
                return False
            from openfeature import api as _of_api
            from openfeature.hook import Hook as _OFHook
        except Exception:
            return False

        class NeatFlagEvaluationHook(_OFHook):  # type: ignore[misc, valid-type]
            def after(self, hook_context, details, hints):
                try:
                    _neat_record_flag(neat_flag_event_attributes(hook_context, details))
                except Exception:
                    pass  # never break flag evaluation

            def error(self, hook_context, exception, hints):
                try:
                    _neat_record_flag(
                        neat_flag_event_attributes(hook_context, exception=exception)
                    )
                except Exception:
                    pass  # never break flag evaluation

        try:
            _of_api.add_hooks([NeatFlagEvaluationHook()])
            _NEAT_FLAG_HOOKED = True
            return True
        except Exception:
            return False

    def register() -> bool:
        """Add the call-site processor to the active tracer provider, once.

        Returns True if the processor was added (or already present), False if
        the provider does not accept span processors yet (e.g. the default
        no-op provider before the SDK is configured).
        """
        global _NEAT_REGISTERED
        attach_flag_hook()
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

    def attach_flag_hook() -> bool:
        return False


def neat_post_instrument(*_args, **_kwargs) -> None:
    """Entry point invoked by ``opentelemetry-instrument`` after the SDK
    provider is configured and the instrumentors are applied. This is the
    zero-source-edit delivery: the runner loads it via the
    ``opentelemetry_post_instrument`` entry point (see pyproject.toml).
    """
    register()
