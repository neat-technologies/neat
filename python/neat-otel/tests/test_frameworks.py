"""Real-framework proof: instrument a FastAPI and a Flask app, drive a request
whose handler makes a real outbound HTTP call to a local server, and assert the
outbound CLIENT span is attributed to the handler's own file:line — with no edit
to the app code.
"""

import contextlib
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("flask")

from typing import Optional

import requests
from opentelemetry import trace
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import SpanKind

import neat_otel


@contextlib.contextmanager
def _global_provider():
    """A global tracer provider plus neat_otel.register() — the real attachment
    path. register() installs the handler-entry patches, so routes defined after
    it are wrapped; it must run before the app's routes are declared.
    """
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
    trace.set_tracer_provider(provider)
    neat_otel.register()
    yield provider, exporter


def _server_span(spans):
    return [s for s in spans if s.kind == SpanKind.SERVER]


class _Quiet(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_args):
        pass


@contextlib.contextmanager
def _local_server():
    server = HTTPServer(("127.0.0.1", 0), _Quiet)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/"
    finally:
        server.shutdown()


@contextlib.contextmanager
def _instrumented():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(neat_otel.NeatCallSiteSpanProcessor())
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    RequestsInstrumentor().instrument(tracer_provider=provider)
    try:
        yield provider, exporter
    finally:
        RequestsInstrumentor().uninstrument()


def _client_span(spans):
    return [s for s in spans if s.kind == SpanKind.CLIENT]


def test_fastapi_client_span_attributed_to_handler():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    with _local_server() as upstream, _instrumented() as (provider, exporter):
        app = FastAPI()

        @app.get("/hit")
        def handler():
            requests.get(upstream)  # <- the CLIENT call site
            return {"ok": True}

        FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
        TestClient(app).get("/hit")

        spans = _client_span(exporter.get_finished_spans())
        assert spans, "expected an outbound CLIENT span"
        attrs = spans[0].attributes
        assert attrs["code.file.path"].endswith("test_frameworks.py")
        assert attrs["code.function.name"] == "handler"


def test_flask_client_span_attributed_to_handler():
    from flask import Flask
    from opentelemetry.instrumentation.flask import FlaskInstrumentor

    with _local_server() as upstream, _instrumented() as (provider, exporter):
        app = Flask(__name__)

        @app.get("/hit")
        def handler():
            requests.get(upstream)  # <- the CLIENT call site
            return {"ok": True}

        FlaskInstrumentor().instrument_app(app, tracer_provider=provider)
        app.test_client().get("/hit")

        spans = _client_span(exporter.get_finished_spans())
        assert spans, "expected an outbound CLIENT span"
        attrs = spans[0].attributes
        assert attrs["code.file.path"].endswith("test_frameworks.py")
        assert attrs["code.function.name"] == "handler"
        FlaskInstrumentor().uninstrument_app(app)


def test_fastapi_server_span_attributed_to_handler():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    with _global_provider() as (provider, exporter):
        app = FastAPI()

        @app.get("/items/{item_id}")
        def read_item(item_id: int, q: Optional[str] = None):  # <- the handler
            return {"item_id": item_id, "q": q}

        FastAPIInstrumentor.instrument_app(app, tracer_provider=provider)
        try:
            resp = TestClient(app).get("/items/7?q=hi")
            # Dependency injection still resolves path + query through the wrap.
            assert resp.status_code == 200
            assert resp.json() == {"item_id": 7, "q": "hi"}

            server = _server_span(exporter.get_finished_spans())
            assert server, "expected a SERVER span"
            attrs = server[0].attributes
            assert attrs["code.file.path"].endswith("test_frameworks.py")
            assert attrs["code.function.name"] == "read_item"
            assert isinstance(attrs["code.line.number"], int)
        finally:
            FastAPIInstrumentor.uninstrument_app(app)


def test_flask_server_span_attributed_to_handler():
    from flask import Flask
    from opentelemetry.instrumentation.flask import FlaskInstrumentor

    with _global_provider() as (provider, exporter):
        app = Flask(__name__)

        @app.get("/items/<int:item_id>")
        def read_item(item_id):  # <- the handler
            return {"item_id": item_id}

        FlaskInstrumentor().instrument_app(app, tracer_provider=provider)
        try:
            resp = app.test_client().get("/items/7")
            assert resp.status_code == 200
            server = _server_span(exporter.get_finished_spans())
            assert server, "expected a SERVER span"
            attrs = server[0].attributes
            assert attrs["code.file.path"].endswith("test_frameworks.py")
            assert attrs["code.function.name"] == "read_item"
            assert isinstance(attrs["code.line.number"], int)
        finally:
            FlaskInstrumentor().uninstrument_app(app)
