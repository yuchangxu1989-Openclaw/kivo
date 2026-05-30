#!/usr/bin/env python3
"""
BGE Embedding Server for KIVO.

Modes:
  1. Pipe mode (default): reads JSON lines from stdin, writes embeddings to stdout.
  2. HTTP serve mode (--serve): starts HTTP server on localhost:9876.
     POST /embed  body: {"texts": ["text1", "text2"]}
     Response: {"embeddings": [[...], [...]]}
     POST /v1/embeddings  body: {"model": "bge-m3", "input": ["text1", "text2"]}
     Response: OpenAI-compatible embeddings response
"""
import sys
import json
import fcntl
import argparse
import os
from pathlib import Path
from urllib import request, error
from concurrent.futures import ThreadPoolExecutor

# Embedding provider defaults. Override with environment variables.
os.environ.setdefault("EMBEDDING_PROVIDER", "volcengine")
os.environ.setdefault("VOLCENGINE_ENDPOINT", "ep-20260526003131-fgvsx")
os.environ.setdefault("EMBED_BATCH_LIMIT", "50")
os.environ.setdefault("EMBED_WORKERS", "8")

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


def read_ark_api_key_from_openclaw():
    config_path = Path(os.environ.get("OPENCLAW_CONFIG_PATH", "/root/.openclaw/openclaw.json"))
    if not config_path.exists():
        return ""
    try:
        raw = json.loads(config_path.read_text())
        return raw.get("models", {}).get("providers", {}).get("volcengine-ark", {}).get("apiKey", "")
    except Exception:
        return ""


def run_pipe_mode(model):
    """Original pipe mode: read JSON lines from stdin, write embeddings to stdout."""
    print(json.dumps({"status": "ready", "model": "bge-small-zh-v1.5", "dimensions": 512}), flush=True)

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
    """HTTP serve mode: proxy embedding requests to configured provider."""
    from http.server import HTTPServer, BaseHTTPRequestHandler

    PROVIDER = os.environ.get("EMBEDDING_PROVIDER", "volcengine").strip().lower()
    if PROVIDER not in {"local", "volcengine"}:
        print(json.dumps({"error": f"Unsupported EMBEDDING_PROVIDER: {PROVIDER}. Use local or volcengine"}), flush=True)
        sys.exit(1)

    OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "bge-m3:latest")
    OLLAMA_DIMENSIONS = 1024

    VOLCENGINE_URL = "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal"
    VOLCENGINE_API_KEY = os.environ.get("VOLCENGINE_API_KEY", "") or read_ark_api_key_from_openclaw()
    VOLCENGINE_ENDPOINT = os.environ.get("VOLCENGINE_ENDPOINT", "ep-20260526003131-fgvsx")
    VOLCENGINE_MODEL_NAME = "doubao-embedding-vision-251215"
    VOLCENGINE_DIMENSIONS = 2048
    EMBED_BATCH_LIMIT = max(1, int(os.environ.get("EMBED_BATCH_LIMIT", "50")))
    EMBED_WORKERS = max(1, int(os.environ.get("EMBED_WORKERS", "8")))

    if PROVIDER == "volcengine" and not VOLCENGINE_API_KEY:
        print(json.dumps({"error": "VOLCENGINE_API_KEY is required when EMBEDDING_PROVIDER=volcengine"}), flush=True)
        sys.exit(1)

    def json_response(handler, status_code, payload):
        body = json.dumps(payload).encode()
        handler.send_response(status_code)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def http_json(url, payload=None, headers=None, method="POST", timeout=60):
        if payload is None:
            req = request.Request(url, method=method, headers=headers or {})
        else:
            body = json.dumps(payload).encode()
            req_headers = {"Content-Type": "application/json"}
            if headers:
                req_headers.update(headers)
            req = request.Request(url, data=body, method=method, headers=req_headers)

        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return {}
            return json.loads(raw)

    def call_ollama(path, payload=None, timeout=60):
        method = "GET" if payload is None else "POST"
        return http_json(f"{OLLAMA_BASE_URL}{path}", payload=payload, method=method, timeout=timeout)

    def ollama_embed(text):
        data = call_ollama("/api/embeddings", {"model": OLLAMA_MODEL, "prompt": text})
        embedding = data.get("embedding")
        if not isinstance(embedding, list):
            raise ValueError("Ollama response missing embedding array")
        return embedding

    def volcengine_embed_one(text):
        payload = {
            "model": VOLCENGINE_ENDPOINT,
            "input": [{"type": "text", "text": text}],
        }
        headers = {"Authorization": f"Bearer {VOLCENGINE_API_KEY}"}
        data = http_json(VOLCENGINE_URL, payload=payload, headers=headers, timeout=120)
        response_data = data.get("data")
        if isinstance(response_data, dict):
            embedding = response_data.get("embedding")
            if isinstance(embedding, list):
                return embedding
        elif isinstance(response_data, list) and response_data:
            first = response_data[0]
            if isinstance(first, dict) and isinstance(first.get("embedding"), list):
                return first.get("embedding")
        raise ValueError("Volcengine response missing embedding array")

    def volcengine_embed_batch(texts):
        if len(texts) > EMBED_BATCH_LIMIT:
            result = []
            for start in range(0, len(texts), EMBED_BATCH_LIMIT):
                result.extend(volcengine_embed_batch(texts[start:start + EMBED_BATCH_LIMIT]))
            return result
        with ThreadPoolExecutor(max_workers=min(EMBED_WORKERS, len(texts) or 1)) as pool:
            return list(pool.map(volcengine_embed_one, texts))

    def embed_texts(texts):
        if PROVIDER == "volcengine":
            return volcengine_embed_batch(texts)
        with ThreadPoolExecutor(max_workers=min(EMBED_WORKERS, len(texts) or 1)) as pool:
            return list(pool.map(ollama_embed, texts))

    def active_model_name(requested_model=None):
        if PROVIDER == "volcengine":
            return VOLCENGINE_MODEL_NAME
        return requested_model or "bge-m3"

    def active_dimensions():
        return VOLCENGINE_DIMENSIONS if PROVIDER == "volcengine" else OLLAMA_DIMENSIONS

    class EmbedHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path not in {"/embed", "/v1/embeddings", "/api/embeddings"}:
                json_response(self, 404, {"error": "Not found. Use POST /embed, POST /v1/embeddings, or POST /api/embeddings"})
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

            is_openai_compat = self.path == "/v1/embeddings"
            is_ollama_compat = self.path == "/api/embeddings"
            if is_openai_compat:
                input_value = data.get("input")
                if isinstance(input_value, str):
                    texts = [input_value]
                elif isinstance(input_value, list) and all(isinstance(t, str) for t in input_value):
                    texts = input_value
                else:
                    json_response(self, 400, {"error": "Body must have 'input' as a string or array of strings"})
                    return
            elif is_ollama_compat:
                prompt = data.get("prompt")
                if not isinstance(prompt, str):
                    json_response(self, 400, {"error": "Body must have 'prompt' as string"})
                    return
                texts = [prompt]
            else:
                texts = data.get("texts")
                if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                    json_response(self, 400, {"error": "Body must have 'texts' as array of strings"})
                    return

            if len(texts) == 0:
                if is_openai_compat:
                    json_response(self, 200, {
                        "object": "list",
                        "data": [],
                        "model": active_model_name(data.get("model")),
                        "usage": {"prompt_tokens": 0, "total_tokens": 0},
                    })
                elif is_ollama_compat:
                    json_response(self, 200, {"embedding": []})
                else:
                    json_response(self, 200, {"embeddings": [], "dimensions": active_dimensions(), "count": 0})
                return

            try:
                result = embed_texts(texts)
                if is_openai_compat:
                    response = {
                        "object": "list",
                        "data": [
                            {"object": "embedding", "index": idx, "embedding": embedding}
                            for idx, embedding in enumerate(result)
                        ],
                        "model": active_model_name(data.get("model")),
                        "usage": {"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
                    }
                elif is_ollama_compat:
                    response = {"embedding": result[0]}
                else:
                    response = {"embeddings": result, "dimensions": active_dimensions(), "count": len(result)}
                json_response(self, 200, response)
            except (error.URLError, TimeoutError) as e:
                json_response(self, 502, {"error": f"Embedding provider unavailable: {e}"})
            except Exception as e:
                json_response(self, 500, {"error": f"Embedding failed: {e}"})

        def do_GET(self):
            if self.path == "/health":
                try:
                    if PROVIDER == "local":
                        call_ollama("/api/tags", timeout=5)
                    json_response(self, 200, {"status": "ok", "backend": PROVIDER, "model": active_model_name(), "dimensions": active_dimensions()})
                except Exception as e:
                    json_response(self, 503, {"status": "error", "backend": PROVIDER, "error": str(e)})
            else:
                json_response(self, 404, {"error": "Use POST /embed or GET /health"})

        def log_message(self, format, *args):
            sys.stderr.write(f"[bge-embed] {args[0]} {args[1]} {args[2]}\n")

    server = HTTPServer(("127.0.0.1", port), EmbedHandler)
    print(f"BGE Embedding HTTP proxy started on http://127.0.0.1:{port}", flush=True)
    if PROVIDER == "volcengine":
        print(f"  Backend: volcengine endpoint={VOLCENGINE_ENDPOINT} batch_limit={EMBED_BATCH_LIMIT}", flush=True)
    else:
        print(f"  Backend: {OLLAMA_BASE_URL} model={OLLAMA_MODEL}", flush=True)
    print(f"  POST /embed          - encode texts", flush=True)
    print(f"  POST /api/embeddings - Ollama-compatible single prompt", flush=True)
    print(f"  POST /v1/embeddings  - OpenAI-compatible embeddings", flush=True)
    print(f"  GET  /health         - health check", flush=True)

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
