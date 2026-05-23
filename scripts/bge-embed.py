#!/usr/bin/env python3
"""
BGE Embedding Server for KIVO.

Modes:
  1. Pipe mode (default): reads JSON lines from stdin, writes embeddings to stdout.
  2. HTTP serve mode (--serve): starts HTTP server on localhost:9876.
     POST /embed  body: {"texts": ["text1", "text2"]}
     Response: {"embeddings": [[...], [...]]}

Usage:
  # Pipe mode (legacy, fallback):
  echo '["hello world", "你好世界"]' | python3 scripts/bge-embed.py

  # HTTP serve mode:
  python3 scripts/bge-embed.py --serve
  curl -s http://localhost:9876/embed -H 'Content-Type: application/json' -d '{"texts":["测试"]}'
"""
import sys
import json
import fcntl
import argparse

# Singleton guard: only one bge-embed instance at a time
_lock_fd = open("/tmp/bge-embed.lock", "w")
try:
    fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print(json.dumps({"error": "Another bge-embed instance is already running"}), flush=True)
    sys.exit(1)


def load_model():
    """Load the BGE model once and return it."""
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        err = json.dumps({"error": "sentence-transformers not installed. Run: pip install sentence-transformers"})
        print(err, flush=True)
        sys.exit(1)

    try:
        model = SentenceTransformer("BAAI/bge-small-zh-v1.5")
    except Exception as e:
        err = json.dumps({"error": f"Failed to load model: {e}"})
        print(err, flush=True)
        sys.exit(1)

    return model


def encode_texts(model, texts):
    """Encode a list of texts and return list of embedding vectors."""
    embeddings = model.encode(texts, normalize_embeddings=True)
    return [vec.tolist() for vec in embeddings]


def run_pipe_mode(model):
    """Original pipe mode: read JSON lines from stdin, write embeddings to stdout."""
    # Signal ready
    print(json.dumps({"status": "ready", "model": "bge-small-zh-v1.5", "dimensions": 512}), flush=True)

    # Loop: read one JSON line, process, write one JSON line
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            texts = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON input: {e}"}), flush=True)
            continue

        if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
            print(json.dumps({"error": "Input must be a JSON array of strings"}), flush=True)
            continue

        if len(texts) == 0:
            print(json.dumps([]), flush=True)
            continue

        try:
            result = encode_texts(model, texts)
            print(json.dumps(result), flush=True)
        except Exception as e:
            print(json.dumps({"error": f"Encoding failed: {e}"}), flush=True)


def run_serve_mode(port=9876):
    """HTTP serve mode: proxy embedding requests to local Ollama."""
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from urllib import request, error

    OLLAMA_BASE_URL = "http://localhost:11434"
    OLLAMA_MODEL = "bge-m3:latest"
    OLLAMA_DIMENSIONS = 1024

    def json_response(handler, status_code, payload):
        body = json.dumps(payload).encode()
        handler.send_response(status_code)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def call_ollama(path, payload=None, timeout=60):
        url = f"{OLLAMA_BASE_URL}{path}"
        if payload is None:
            req = request.Request(url, method="GET")
        else:
            body = json.dumps(payload).encode()
            req = request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json"})

        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return {}
            return json.loads(raw)

    def ollama_embed(text):
        data = call_ollama("/api/embeddings", {"model": OLLAMA_MODEL, "prompt": text})
        embedding = data.get("embedding")
        if not isinstance(embedding, list):
            raise ValueError("Ollama response missing embedding array")
        return embedding

    class EmbedHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/embed":
                json_response(self, 404, {"error": "Not found. Use POST /embed"})
                return

            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                json_response(self, 400, {"error": "Empty request body"})
                return

            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
            except json.JSONDecodeError as e:
                json_response(self, 400, {"error": f"Invalid JSON: {e}"})
                return

            texts = data.get("texts")
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                json_response(self, 400, {"error": "Body must have 'texts' as array of strings"})
                return

            if len(texts) == 0:
                json_response(self, 200, {"embeddings": [], "dimensions": OLLAMA_DIMENSIONS, "count": 0})
                return

            try:
                result = [ollama_embed(text) for text in texts]
                response = {"embeddings": result, "dimensions": OLLAMA_DIMENSIONS, "count": len(result)}
                json_response(self, 200, response)
            except (error.URLError, TimeoutError) as e:
                json_response(self, 502, {"error": f"Ollama unavailable: {e}"})
            except Exception as e:
                json_response(self, 500, {"error": f"Embedding failed: {e}"})

        def do_GET(self):
            if self.path == "/health":
                try:
                    call_ollama("/api/tags", timeout=5)
                    json_response(self, 200, {"status": "ok", "backend": "ollama", "model": OLLAMA_MODEL, "dimensions": OLLAMA_DIMENSIONS})
                except Exception as e:
                    json_response(self, 503, {"status": "error", "backend": "ollama", "error": str(e)})
            else:
                json_response(self, 404, {"error": "Use POST /embed or GET /health"})

        def log_message(self, format, *args):
            # Log to stderr for systemd journal
            sys.stderr.write(f"[bge-embed] {args[0]} {args[1]} {args[2]}\n")

    server = HTTPServer(("127.0.0.1", port), EmbedHandler)
    print(f"BGE Embedding HTTP proxy started on http://127.0.0.1:{port}", flush=True)
    print(f"  Backend: {OLLAMA_BASE_URL} model={OLLAMA_MODEL}", flush=True)
    print(f"  POST /embed  - encode texts", flush=True)
    print(f"  GET  /health - health check", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...", flush=True)
        server.shutdown()


def main():
    parser = argparse.ArgumentParser(description="BGE Embedding Server for KIVO")
    parser.add_argument("--serve", action="store_true", help="Start HTTP server mode on localhost:9876")
    parser.add_argument("--port", type=int, default=9876, help="HTTP port (default: 9876)")
    args = parser.parse_args()

    if args.serve:
        run_serve_mode(port=args.port)
    else:
        model = load_model()
        run_pipe_mode(model)


if __name__ == "__main__":
    main()
