#!/usr/bin/env python3
"""
BGE Embedding Server for KIVO — persistent stdin/stdout pipe mode.

Loads BAAI/bge-small-zh-v1.5 once, then loops reading JSON lines from stdin.
Each line: a JSON array of strings → outputs a JSON array of embedding vectors.
Exits on EOF or empty line.

Usage (pipe mode, default):
  # Start as persistent process, send JSON lines:
  echo '["hello world", "你好世界"]' | python3 scripts/bge-embed.py

  # Or keep alive and send multiple batches:
  python3 scripts/bge-embed.py <<EOF
  ["batch one text"]
  ["batch two text", "another"]
  EOF
"""

import sys
import json


def main():
    # Load model once at startup
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
            embeddings = model.encode(texts, normalize_embeddings=True)
            result = [vec.tolist() for vec in embeddings]
            print(json.dumps(result), flush=True)
        except Exception as e:
            print(json.dumps({"error": f"Encoding failed: {e}"}), flush=True)


if __name__ == "__main__":
    main()
