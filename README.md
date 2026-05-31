# KIVO — 知识自主更新平台

> Knowledge & Intent Evolution Platform for agent workspaces.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/@self-evolving-harness/kivo.svg)](https://www.npmjs.com/package/@self-evolving-harness/kivo)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org/)
[![OpenClaw](https://img.shields.io/badge/host-OpenClaw-black.svg)](https://github.com/yuchangxu1989-Openclaw)

KIVO turns scattered sessions, documents, and corrections into reusable knowledge that your agents can retrieve, relate, and inject at the moment they need it.

KIVO is knowledge infrastructure for LLM systems that extracts durable facts from messy inputs, vectorizes them for semantic retrieval, links them through graph relations, and injects intent-aware context back into agent work.

## Quick Start

### 1. Install

```bash
npm install @self-evolving-harness/kivo
```

### 2. Initialize the workspace knowledge base

```bash
npx kivo init --yes
```

### 3. Add and query knowledge

```bash
npx kivo add fact "TypeScript decorators in 5.0" \
  --content "TypeScript 5.0 adds support for the Stage 3 decorators proposal." \
  --tags "typescript,decorators"

npx kivo query "How do decorators work in TypeScript?"
```

After initialization, KIVO creates the local knowledge store, installs the workspace hooks, and enables the retrieval pipeline used by agent sessions.

## Core Concepts

### Behavior-change gate

KIVO stores knowledge only when it can change an agent decision. That keeps the repository focused on operational memory instead of turning into a generic note archive.

### Extraction pipeline

Raw conversations, documents, and corrections move through an extraction pipeline that decomposes content into atomic entries, removes context dependence, filters low-value material, and persists reusable knowledge.

### Vector retrieval

KIVO uses embedding-based search to find semantically related entries from natural-language queries. Retrieval is built for meaning, not keyword matching.

### Graph expansion

Matched entries can be expanded through graph relationships so agents receive nearby concepts, constraints, and supporting facts instead of isolated snippets.

### Intent injection

KIVO injects relevant knowledge into agent context automatically. The goal is not manual lookup; it is timely recall inside real work.

### Gap-driven evolution

KIVO tracks misses, weak coverage areas, and isolated graph regions, then turns those blind spots into follow-up knowledge work so the system improves over time.

## Architecture Overview

KIVO runs as a knowledge operating layer on top of OpenClaw and connects ingestion, retrieval, graph reasoning, and agent-time injection in one loop.

```text
Sessions / Docs / Corrections
            |
            v
   Extraction + Normalization
            |
            v
   Behavior-Change Admission Gate
            |
            v
 Embeddings + Knowledge Repository
            |
            +--> Graph Relations
            |
            v
 Semantic Retrieval + Intent Match
            |
            v
 Context Injection into Agent Workflows
            |
            v
 Query Misses / Coverage Gaps / New Corrections
            |
            +--> Research and Governance Loops
```

What this architecture gives you:

- A persistent knowledge base for agent workspaces
- Semantic retrieval for facts, rules, and prior decisions
- Graph-linked context instead of flat search results
- Intent-aware prompt injection during active sessions
- Governance loops for deduplication, conflict handling, and quality review

## Contributing

Contributions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make the change with tests or validation where relevant.
4. Open a pull request with the problem, the change, and the evidence.

For local development:

```bash
npm install
npm run build
npm run test
```

## License

MIT. See `LICENSE` for details.
