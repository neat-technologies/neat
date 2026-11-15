"""Django handler-entry: wrap each URL pattern's view so it stamps the SERVER
span with the view's own code location when it runs."""

from __future__ import annotations

import os

from ._handler import _neat_endpoint_location, _neat_stamp_server


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
