#!/usr/bin/env node
/**
 * KIVO Intent Extraction Worker
 *
 * Processes queued messages from the hook and extracts high-value knowledge
 * using LLM semantic judgment. Writes extracted entries to the KIVO DB.
 *
 * This script is spawned as a detached background process by the hook handler.
 * It uses the same LLM config resolution as KIVO's extract-sessions command.
 *
 * Usage: node extract-queue-worker.mjs [--queue-path <path>] [--db-path <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// --- Config resolution (mirrors KIVO's resolveLlmConfig) ---

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_BASE_URL = 'https://api.penguinsaichat.dpdns.org/v1';

function normalizeBaseUrl(raw) {
  let url = raw.replace(/\/+$/, '');
  if (!url.endsWith('/v1')) url += '/v1';
  return url;
}

function resolveLlmConfig() {
  const envKey = process.env.OPENAI_API_KEY ?? '';
  const envBase = process.env.OPENAI_BASE_URL ?? '';
  const envModel = process.env.KIVO_LLM_MODEL ?? '';

  if (envKey && !envBase.includes('api2.penguinsaichat')) {
    return { apiKey: envKey, baseUrl: envBase || DEFAULT_BASE_URL, model: envModel || DEFAULT_MODEL };
  }

  const ocPath = path.resolve(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');
  if (!fs.existsSync(ocPath)) return { error: 'No openclaw.json found' };

  let ocConfig;
  try { ocConfig = JSON.parse(fs.readFileSync(ocPath, 'utf-8')); } catch { return { error: 'Failed to parse openclaw.json' }; }

  const providers = ocConfig?.models?.providers;
  if (!providers || typeof providers !== 'object') return { error: 'No providers in openclaw.json' };

  // Prefer penguin-main
  const penguinMain = providers['penguin-main'];
  if (penguinMain?.apiKey) {
    return { apiKey: penguinMain.apiKey, baseUrl: penguinMain.baseUrl ? normalizeBaseUrl(penguinMain.baseUrl) : DEFAULT_BASE_URL, model: envModel || DEFAULT_MODEL };
  }

  // Find first penguin provider (not api2)
  for (const [, provider] of Object.entries(providers)) {
    if (provider?.apiKey && provider.baseUrl && provider.baseUrl.includes('api.penguinsaichat') && !provider.baseUrl.includes('api2.penguinsaichat')) {
      return { apiKey: provider.apiKey, baseUrl: normalizeBaseUrl(provider.baseUrl), model: envModel || DEFAULT_MODEL };
    }
  }

  // Fallback to openai provider
  const openai = providers['openai'];
  if (openai?.apiKey) {
    return { apiKey: openai.apiKey, baseUrl: openai.baseUrl ? normalizeBaseUrl(openai.baseUrl) : DEFAULT_BASE_URL, model: envModel || DEFAULT_MODEL };
  }

  return { error: 'No API key found in any provider' };
}

// --- LLM call ---

async function llmComplete(config, prompt) {
  const url = `${config.baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM API error ${resp.status}: ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

const EXTRACTION_SYSTEM_PROMPT = `你是 KIVO 知识萃取引擎。你的任务是从用户对话中识别并提取高价值知识。

高价值知识的判断标准：
- 用户私有术语/黑话（LLM 不可能知道的）
- 反复出现的纠偏（用户多次强调的规则）
- 专业领域定制意图（LLM 理解浅的）
- 容易被遗忘的关键约束
- 复杂意图、隐含意图、间接意图
- 用户特有的指代和简写
- 重要决策及其原因
- 方法论和经验教训

低价值（不应提取）：
- 通用常识（LLM 本来就会）
- 纯粹的任务指令（"帮我写个函数"）
- 闲聊、问候
- 临时性的一次性信息

输出格式：JSON 数组，每个元素包含：
{
  "type": "intent|decision|methodology|experience|fact",
  "title": "简短标题（20字以内）",
  "content": "完整知识内容（具体、可执行、场景化）",
  "confidence": 0.0-1.0,
  "tags": ["标签1", "标签2"],
  "domain": "知识所属领域"
}

如果对话中没有高价值知识，返回空数组 []。
只返回 JSON，不要其他文字。`;

// --- DB operations ---

let _DatabaseClass = null;

async function loadBetterSqlite3() {
  if (_DatabaseClass) return _DatabaseClass;

  try {
    const mod = await import('better-sqlite3');
    _DatabaseClass = mod.default || mod;
    return _DatabaseClass;
  } catch { /* fallback */ }

  // Try from KIVO project
  const kivoPath = '/root/.openclaw/workspace/projects/kivo/node_modules/better-sqlite3/lib/index.js';
  try {
    const mod = await import(kivoPath);
    _DatabaseClass = mod.default || mod;
    return _DatabaseClass;
  } catch { /* fallback */ }

  throw new Error('better-sqlite3 not found');
}

function writeEntriesToDb(dbPath, entries) {
  if (!entries || entries.length === 0) return 0;

  const Database = _DatabaseClass;
  const db = new Database(dbPath);

  const insert = db.prepare(`
    INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, datetime('now'), datetime('now'), 1)
  `);

  let written = 0;
  const tx = db.transaction((items) => {
    for (const entry of items) {
      try {
        const sourceJson = JSON.stringify({ type: 'hook-extraction', id: 'kivo-intent-hook', extractedAt: new Date().toISOString() });
        insert.run(
          entry.id,
          entry.type,
          entry.title,
          entry.content,
          entry.content?.substring(0, 200) || '',
          sourceJson,
          entry.confidence,
          JSON.stringify(entry.tags || []),
          entry.domain || 'general',
        );
        written++;
      } catch (err) {
        // Skip duplicates or constraint violations
        if (!err.message.includes('UNIQUE')) {
          console.error(`[extract-worker] DB write error: ${err.message}`);
        }
      }
    }
  });

  try {
    tx(entries);
  } finally {
    db.close();
  }

  return written;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  let queuePath = '';
  let dbPath = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--queue-path' && args[i + 1]) queuePath = args[++i];
    if (args[i] === '--db-path' && args[i + 1]) dbPath = args[++i];
  }

  if (!queuePath || !dbPath) {
    console.error('[extract-worker] Missing --queue-path or --db-path');
    process.exit(1);
  }

  if (!fs.existsSync(queuePath)) {
    console.log('[extract-worker] Queue file does not exist, nothing to process');
    process.exit(0);
  }

  // Read and clear queue atomically (rename then read)
  const processingPath = queuePath + '.processing';
  try {
    fs.renameSync(queuePath, processingPath);
  } catch (err) {
    if (err.code === 'ENOENT') { process.exit(0); }
    throw err;
  }

  const raw = fs.readFileSync(processingPath, 'utf-8').trim();
  if (!raw) {
    fs.unlinkSync(processingPath);
    process.exit(0);
  }

  const messages = raw.split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  if (messages.length === 0) {
    fs.unlinkSync(processingPath);
    process.exit(0);
  }

  // Resolve LLM config
  const llmConfig = resolveLlmConfig();
  if ('error' in llmConfig) {
    console.error(`[extract-worker] LLM config error: ${llmConfig.error}`);
    // Put messages back in queue for next attempt
    fs.renameSync(processingPath, queuePath);
    process.exit(1);
  }

  // Group messages into conversation chunks (by session, max 10 messages per chunk)
  const sessionGroups = new Map();
  for (const msg of messages) {
    const key = msg.sessionKey || 'unknown';
    if (!sessionGroups.has(key)) sessionGroups.set(key, []);
    sessionGroups.get(key).push(msg);
  }

  let totalExtracted = 0;

  // Load better-sqlite3 before processing
  await loadBetterSqlite3();

  for (const [sessionKey, sessionMsgs] of sessionGroups) {
    // Process in chunks of 10
    for (let i = 0; i < sessionMsgs.length; i += 10) {
      const chunk = sessionMsgs.slice(i, i + 10);
      const conversationText = chunk.map(m =>
        `[${m.timestamp || 'unknown'}] ${m.role || 'user'}: ${m.content}`
      ).join('\n');

      const prompt = `以下是一段对话记录，请从中提取高价值知识：\n\n${conversationText}`;

      try {
        const response = await llmComplete(llmConfig, prompt);

        // Parse JSON response
        let candidates = [];
        try {
          // Try to extract JSON from response (might be wrapped in markdown code block)
          const jsonMatch = response.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            candidates = JSON.parse(jsonMatch[0]);
          }
        } catch {
          console.error(`[extract-worker] Failed to parse LLM response for session ${sessionKey}`);
          continue;
        }

        if (!Array.isArray(candidates) || candidates.length === 0) continue;

        // Validate and enrich entries
        const validEntries = candidates
          .filter(c => c && c.type && c.title && c.content && (c.confidence ?? 0) >= 0.6)
          .map(c => ({
            id: randomUUID(),
            type: c.type,
            title: c.title.substring(0, 60),
            content: c.content,
            confidence: Math.min(1, Math.max(0, c.confidence ?? 0.7)),
            domain: c.domain || 'general',
            tags: Array.isArray(c.tags) ? c.tags : [],
          }));

        if (validEntries.length > 0) {
          const written = writeEntriesToDb(dbPath, validEntries);
          totalExtracted += written;
          console.log(`[extract-worker] Extracted ${written} entries from session ${sessionKey.substring(0, 30)}`);
        }
      } catch (err) {
        console.error(`[extract-worker] LLM extraction failed: ${err.message}`);
        // Continue with next chunk, don't abort entirely
      }
    }
  }

  // Clean up processing file
  fs.unlinkSync(processingPath);
  console.log(`[extract-worker] Done. Total extracted: ${totalExtracted} entries from ${messages.length} messages`);
}

main().catch(err => {
  console.error(`[extract-worker] Fatal error: ${err.message}`);
  process.exit(1);
});
