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

    def _neat_django_location(callback, request):
        """The code location of the view that will handle this request.

        A function view is its own location. A class-based view's callback is
        Django's ``view`` closure inside django/views, so unwrapping it would
        land on Django's file; the class carries the code instead, and the HTTP
        method picks the method that runs: a DRF viewset maps it through
        ``actions`` (``{"get": "list"}``), an APIView or Django CBV dispatches to
        the method named after the verb. Falls back to the class itself.
        """
        cls = getattr(callback, "cls", None) or getattr(callback, "view_class", None)
        if cls is None:
            return _neat_endpoint_location(callback)
        try:
            import inspect

            verb = str(getattr(request, "method", "") or "").lower()
            actions = getattr(callback, "actions", None) or {}
            method_name = actions.get(verb) or verb
            fn = getattr(cls, method_name, None) if method_name else None
            if fn is not None and callable(fn):
                loc = _neat_endpoint_location(fn)
                if loc is not None:
                    return (loc[0], loc[1], f"{cls.__qualname__}.{loc[2]}")
            filepath = inspect.getsourcefile(cls)
            _, lineno = inspect.getsourcelines(cls)
            if filepath:
                return (os.path.abspath(filepath), lineno, cls.__qualname__)
        except Exception:
            pass
        return None

    def _neat_wrap_django_view(callback):
        """Wrap a Django URL callback so it stamps the SERVER span when it runs.

        ``functools.wraps`` carries the attributes Django and DRF read off the
        callback (``view_class``, ``cls``, ``actions``, ``csrf_exempt``,
        ``__module__``/``__qualname__`` for ``lookup_str``), and the wrap keeps
        an async view async so Django still dispatches it as a coroutine.
        """
        try:
            import inspect
            from functools import wraps

            if not callable(callback) or getattr(callback, "__neat_handler__", False):
                return callback

            def stamp(args):
                request = args[0] if args else None
                location = _neat_django_location(callback, request)
                if location is not None:
                    _neat_stamp_server(*location)

            if inspect.iscoroutinefunction(callback):

                @wraps(callback)
                async def wrapper(*args, **kwargs):
                    stamp(args)
                    return await callback(*args, **kwargs)

            else:

                @wraps(callback)
                def wrapper(*args, **kwargs):
                    stamp(args)
                    return callback(*args, **kwargs)

            wrapper.__neat_handler__ = True
            return wrapper
        except Exception:
            return callback

    def _neat_patch_django() -> None:
        try:
            from django.urls import resolvers
        except Exception:
            return
        pattern_cls = resolvers.URLPattern
        if getattr(pattern_cls.__init__, "__neat_patched__", False):
            return
        original = pattern_cls.__init__

        def __init__(self, pattern, callback, *args, **kwargs):
            return original(self, pattern, _neat_wrap_django_view(callback), *args, **kwargs)

        __init__.__neat_patched__ = True
        pattern_cls.__init__ = __init__

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

    def _neat_install_handler_entry() -> None:
        """Patch FastAPI/Flask/Django route registration so a handler stamps its own
        SERVER span. Patched once, on the classes, before the app module is
        imported under ``opentelemetry-instrument`` — so routes defined later are
        covered. Each framework is independent and guarded; a missing one is a
        silent skip. Django is patched where a URL pattern takes its view
        (``URLPattern``), which ``path()``, ``re_path()`` and DRF routers all
        build.
        """
        global _NEAT_HANDLER_PATCHED
        if _NEAT_HANDLER_PATCHED:
            return
        _NEAT_HANDLER_PATCHED = True
        _neat_patch_fastapi()
        _neat_patch_flask()
        _neat_patch_django()
        _neat_patch_celery()

    def register() -> bool:
        """Add the call-site processor to the active tracer provider, once, and
        install the handler-entry attribution for SERVER spans.

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

    def attach_flag_hook() -> bool:
        return False


def neat_post_instrument(*_args, **_kwargs) -> None:
    """Entry point invoked by ``opentelemetry-instrument`` after the SDK
    provider is configured and the instrumentors are applied. This is the
    zero-source-edit delivery: the runner loads it via the
    ``opentelemetry_post_instrument`` entry point (see pyproject.toml).
    """
    register()
