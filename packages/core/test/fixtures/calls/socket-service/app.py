import os
import socket


def query_product_database(neo4jdb_addr):
    # Env-driven address: the host is resolved at runtime, so the recognizer must
    # NOT guess it — the edge lands on the honest `socket:env` sentinel. This is the
    # bench-416 shape: recommendation reaches its neo4j product database over a raw
    # socket whose address comes from an environment variable.
    host, port_str = neo4jdb_addr.split(":")
    port = int(port_str)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.connect((host, port))
        return s.recv(1024)


def ping_cache():
    # Literal host and port → a named `socket:cache.internal:6379` endpoint.
    c = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    c.connect(("cache.internal", 6379))
    return c


if __name__ == "__main__":
    query_product_database(os.environ["NEO4J_PRODUCT_DATABASE_ENDPOINT"])
