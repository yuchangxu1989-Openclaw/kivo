# guard-2026-06-01-session-extractor-tuple-unpack

- **status**: fixed (code) — extraction blocked on external LLM
- **severity**: P1 (blocks all `kivo extract-sessions` runs, incl. the 2-hourly cron)
- **file**: `scripts/session-knowledge-extractor.py:331`
- **evidence**: V (reproduced via crash trace in `/tmp/kivo-rebuild.txt`)

## Problem

`embed_and_cluster()` unpacked segments as 3-tuples:

```python
texts = [text for _, _, text in segments]   # ValueError: too many values to unpack (expected 3)
```

But segments are 4-tuples `(session_id, ts, text, message_ids)` everywhere else they are
produced (`_flush_group` lines 273/285) and consumed (`filter_noise` line 317, the
top-N reps at line 383, and the no-cluster fallback at lines 339/351 which use index
access `s[0..3]`).

The 3-tuple form is stale — `message_ids` was added to the tuple but this one comprehension
was missed. Any real run crashed at Step 4 before producing candidates. (Dry-run masked it
because dry-run exits at Step 3, before `embed_and_cluster`.)

## Fix

```python
texts = [text for _, _, text, _ in segments]
```

Surgical, single line; matches the 4-tuple shape used by every other site. No behavior change
beyond making Step 4 run.

## Still blocked (not a code issue)

After the fix, the pipeline reaches its LLM stages and fails on the **external** penguin
endpoint (`api.penguinsaichat.dpdns.org`, model `claude-opus-4-6`):

- Step 4.5 LLM admission gate → `HTTP 403 Forbidden` then read timeout.
- KIVO has **no offline fallback** by design (`.claude/rules/kivo-sevo-constraints.md`;
  admission gate is LOCKED at `session-knowledge-extractor.py:514`).

So extraction cannot complete until the LLM endpoint is reachable again. Resume with:

```bash
bash projects/kivo/scripts/rebuild-from-3day-sessions.sh
```

(The script preflights the endpoint and aborts cleanly if it is not 200.)

## Secondary note

BGE embed reported "Another bge-embed instance is already running" (flock singleton, likely
the cron). Non-fatal — it falls back to per-segment clusters — but for a clean clustered run,
schedule the rebuild outside the `0 */2 * * *` cron window.
