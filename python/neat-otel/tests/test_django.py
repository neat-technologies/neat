"""Real-framework proof for Django: register NEAT, declare URL patterns the way
an app does, drive requests through the Django instrumentation's middleware, and
assert each SERVER span carries the code location of the view that handled it.
Covers a function view, a class-based view, a DRF viewset (the action method
chosen by the HTTP verb) and an async view, with no edit to the views.
"""

import inspect
import sys
import types

import pytest

pytest.importorskip("django")
pytest.importorskip("rest_framework")
pytest.importorskip("opentelemetry.instrumentation.django")

import django
from django.conf import settings

if not settings.configured:
    settings.configure(
        DEBUG=True,
        SECRET_KEY="neat-otel-test",
        ALLOWED_HOSTS=["*"],
        ROOT_URLCONF="neat_django_test_urls",
        INSTALLED_APPS=[
            "django.contrib.contenttypes",
            "django.contrib.auth",
            "rest_framework",
        ],
        MIDDLEWARE=[],
        DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}},
        REST_FRAMEWORK={"UNAUTHENTICATED_USER": None},
    )
    django.setup()

from opentelemetry.instrumentation.django import DjangoInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

import neat_otel

EXPORTER = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(EXPORTER))
# register() patches URLPattern, so it must run before the URL patterns exist.
# The handler-entry patch doesn't need the global provider, and leaving it
# alone keeps this module from changing what the other test files see.
neat_otel.register()
DjangoInstrumentor().instrument(tracer_provider=_provider)

from django.http import HttpResponse, JsonResponse
from django.test import Client
from django.urls import path
from django.views import View
from rest_framework import routers, viewsets
from rest_framework.response import Response


def hello(request):
    return HttpResponse("ok")


class ItemView(View):
    def get(self, request):
        return HttpResponse("item")


class ThingViewSet(viewsets.ViewSet):
    def list(self, request):
        return Response([])

    def retrieve(self, request, pk=None):
        return Response({"id": pk})


async def ahello(request):
    return JsonResponse({"ok": True})


router = routers.SimpleRouter()
router.register("things", ThingViewSet, basename="thing")

urls = types.ModuleType("neat_django_test_urls")
urls.urlpatterns = [
    path("hello/", hello),
    path("item/", ItemView.as_view()),
    path("ahello/", ahello),
] + router.urls
sys.modules["neat_django_test_urls"] = urls


def _server_span_for(url):
    EXPORTER.clear()
    response = Client().get(url)
    assert response.status_code == 200
    spans = [s for s in EXPORTER.get_finished_spans() if s.kind == SpanKind.SERVER]
    assert len(spans) == 1, [s.name for s in EXPORTER.get_finished_spans()]
    return spans[0]


def _location(fn):
    return (inspect.getsourcefile(fn), inspect.getsourcelines(fn)[1])


def _assert_stamped(span, fn, name):
    filepath, lineno = _location(fn)
    assert span.attributes.get("code.file.path") == filepath
    assert span.attributes.get("code.line.number") == lineno
    assert span.attributes.get("code.function.name") == name


def test_function_view_stamps_its_own_location():
    _assert_stamped(_server_span_for("/hello/"), hello, "hello")


def test_class_based_view_stamps_the_verb_method_not_django():
    _assert_stamped(_server_span_for("/item/"), ItemView.get, "ItemView.get")


def test_drf_viewset_stamps_the_action_the_verb_maps_to():
    _assert_stamped(_server_span_for("/things/"), ThingViewSet.list, "ThingViewSet.list")
    _assert_stamped(_server_span_for("/things/7/"), ThingViewSet.retrieve, "ThingViewSet.retrieve")


def test_async_view_stays_async_and_is_stamped():
    pattern = next(p for p in urls.urlpatterns if str(p.pattern) == "ahello/")
    assert inspect.iscoroutinefunction(pattern.callback)
    _assert_stamped(_server_span_for("/ahello/"), ahello, "ahello")


def test_wrapped_callbacks_keep_what_django_reads():
    item = next(p for p in urls.urlpatterns if str(p.pattern) == "item/")
    assert item.callback.view_class is ItemView
    assert item.lookup_str.endswith("ItemView")
