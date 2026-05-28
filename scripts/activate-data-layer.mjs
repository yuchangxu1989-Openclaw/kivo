/**
 * activate-data-layer.mjs — Backfill similar_sentences + generate research_tasks
 *
 * Reads penguin-main provider from openclaw.json, calls LLM to generate
 * paraphrases for intent entries, then generates research tasks from graph gaps.
 *
 * Usage: node scripts/activate-data-layer.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve('/root/.openclaw/workspace/projects/kivo/kivo.db');
const CONFIG_PATH = '/root/.openclaw/openclaw.json';
const BATCH_DELAY_MS = 1000;

// ─── LLM Config ───────────────────────────────────────────────────────────────

function getProvider() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const provider = cfg.models?.providers?.['penguin-main'];
  if (!provider?.baseUrl || !provider?.apiKey) {
    throw new Error('penguin-main provider not configured');
  }
  return {
    baseUrl: provider.baseUrl.replace(/\/$/, ''),
    apiKey: provider.apiKey,
  };
}

async function callLlm(messages, { model = 'claude-opus-4-6', maxTokens = 1200, temperature = 0.7 } = {}) {
  const provider = getProvider();
  const url = `${provider.baseUrl}/v1/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function parseJsonArray(raw) {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 15);
    }
    return [];
  } catch {
    // Try to find array in content
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) return arr.filter(s => typeof s === 'string').slice(0, 15);
      } catch { /* ignore */ }
    }
    return [];
  }
}

// ─── Task 1: Backfill similar_sentences ───────────────────────────────────────

async function backfillSimilarSentences(db) {
  console.log('\n═══ Task 1: Backfill similar_sentences ═══\n');

  // Get intents needing backfill from intents table
  const intentsRows = db.prepare(`
    SELECT id, name as title, description as content, 'intents' as source_table
    FROM intents
    WHERE status = 'active'
      AND (similar_sentences_json IS NULL OR similar_sentences_json = '[]' OR similar_sentences_json = '')
  `).all();

  // Get entries with type=intent needing backfill
  const entriesRows = db.prepare(`
    SELECT id, title, content, 'entries' as source_table
    FROM entries
    WHERE type = 'intent'
      AND (similar_sentences IS NULL OR similar_sentences = '[]' OR similar_sentences = '')
  `).all();

  const allRows = [...intentsRows, ...entriesRows];
  console.log(`Found ${intentsRows.length} intents + ${entriesRows.length} entries needing backfill (total: ${allRows.length})`);

  if (allRows.length === 0) {
    console.log('All entries already have similar_sentences. Skipping.');
    return;
  }

  let enriched = 0;
  let failed = 0;

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const progress = `[${i + 1}/${allRows.length}]`;

    try {
      const prompt = `你是一个意图理解专家。给定以下意图知识条目，请生成 7 条用户可能说出的、表达同一意图的不同自然语言句子。

意图标题: ${row.title}
意图内容: ${row.content}

要求：
- 生成的句子应该多样化，覆盖不同的表达方式（口语/书面、简短/详细）
- 每条句子是独立的用户输入，不是对意图的解释
- 返回纯 JSON 数组，如 ["句子1", "句子2", ...]
- 不要包含 markdown 代码块标记`;

      const raw = await callLlm([{ role: 'user', content: prompt }]);
      const sentences = parseJsonArray(raw);

      if (sentences.length === 0) {
        console.log(`${progress} FAIL (empty parse): ${row.title}`);
        failed++;
        continue;
      }

      const now = new Date().toISOString();
      const jsonStr = JSON.stringify(sentences);

      if (row.source_table === 'intents') {
        db.prepare('UPDATE intents SET similar_sentences_json = ?, updated_at = ? WHERE id = ?')
          .run(jsonStr, now, row.id);
      } else {
        db.prepare('UPDATE entries SET similar_sentences = ?, updated_at = ? WHERE id = ?')
          .run(jsonStr, now, row.id);
      }

      enriched++;
      console.log(`${progress} OK (${sentences.length} sentences): ${row.title}`);
    } catch (err) {
      console.log(`${progress} ERROR: ${row.title} — ${err.message}`);
      failed++;
    }

    // Rate limit
    if (i < allRows.length - 1) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\nResult: enriched=${enriched}, failed=${failed}, total=${allRows.length}`);
}

// ─── Task 2: Generate research_tasks ──────────────────────────────────────────

async function generateResearchTasks(db) {
  console.log('\n═══ Task 2: Generate research_tasks ═══\n');

  const existingCount = db.prepare('SELECT COUNT(*) as c FROM research_tasks').get().c;
  if (existingCount >= 5) {
    console.log(`Already have ${existingCount} research tasks. Skipping.`);
    return;
  }

  // Analyze graph for isolated nodes and knowledge gaps
  const orphanNodes = db.prepare(`
    SELECT gn.entry_id, gn.title as label, gn.type
    FROM graph_nodes gn
    LEFT JOIN graph_edges ge1 ON gn.entry_id = ge1.source_id
    LEFT JOIN graph_edges ge2 ON gn.entry_id = ge2.target_id
    WHERE ge1.source_id IS NULL AND ge2.target_id IS NULL
    LIMIT 10
  `).all();

  // Get some active intents for context
  const topIntents = db.prepare(`
    SELECT name, description FROM intents WHERE status='active' ORDER BY hit_count DESC LIMIT 10
  `).all();

  const contextSummary = [
    `孤立节点(无边连接): ${orphanNodes.map(n => `${n.label}(${n.type})`).join(', ') || '无'}`,
    `高频意图: ${topIntents.map(i => i.name).join(', ') || '无'}`,
  ].join('\n');

  const prompt = `你是一个知识管理专家。基于以下知识库现状分析，生成 6 条调研任务建议。这些任务应该帮助填补知识缺口、加深对关键概念的理解。

知识库现状:
${contextSummary}

要求：
- 每条任务包含 title（简短标题）、description（详细描述）、scope（调研范围）、priority（high/medium/low）
- 任务应该是通用的知识管理/系统优化方向，不要涉及具体学科
- 返回 JSON 数组格式: [{"title":"...", "description":"...", "scope":"...", "priority":"..."}]
- 不要包含 markdown 代码块标记`;

  try {
    const raw = await callLlm([{ role: 'user', content: prompt }], { maxTokens: 2000 });
    let tasks = parseJsonArray(raw);

    // If parseJsonArray failed (it expects string array), try object array
    if (tasks.length === 0) {
      let cleaned = raw.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        try { tasks = JSON.parse(match[0]); } catch { /* ignore */ }
      }
      if (tasks.length === 0) {
        try { tasks = JSON.parse(cleaned); } catch { /* ignore */ }
      }
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      console.log('Failed to parse research tasks from LLM response');
      console.log('Raw:', raw.slice(0, 300));
      return;
    }

    const insertStmt = db.prepare(`
      INSERT INTO research_tasks (id, title, description, scope, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `);

    let inserted = 0;
    const now = Date.now();

    for (const task of tasks) {
      if (!task.title || !task.description) continue;
      const id = crypto.randomUUID();
      insertStmt.run(id, task.title, task.description, task.scope || '', task.priority || 'medium', now, now);
      inserted++;
      console.log(`  + ${task.title} [${task.priority || 'medium'}]`);
    }

    console.log(`\nInserted ${inserted} research tasks.`);
  } catch (err) {
    console.log(`ERROR generating research tasks: ${err.message}`);
  }
}

// ─── Task 3: Verify/create domain_goals ───────────────────────────────────────

async function ensureDomainGoals(db) {
  console.log('\n═══ Task 3: Verify domain_goals ═══\n');

  const existing = db.prepare('SELECT * FROM domain_goals').all();
  console.log(`Existing domain_goals: ${existing.length}`);

  if (existing.length >= 2) {
    console.log('Already have enough domain goals. Showing existing:');
    for (const g of existing) {
      console.log(`  - ${g.domain_id}: ${g.purpose}`);
    }
    return;
  }

  // Create 2-3 generic domain goals
  const goals = [
    {
      domain_id: 'system-knowledge',
      purpose: '沉淀系统设计与架构决策知识，确保关键决策可追溯、可复用',
      key_questions: ['系统架构的核心约束是什么', '哪些设计决策需要记录理由', '如何避免重复踩坑'],
      non_goals: ['不追踪具体代码实现细节', '不替代版本控制系统'],
      research_boundary: '聚焦架构层面的决策和方法论，不深入具体技术栈的使用教程',
      priority_signals: ['架构决策', '设计原则', '系统约束', '经验教训'],
    },
    {
      domain_id: 'workflow-optimization',
      purpose: '持续优化工作流程和协作模式，提升效率和质量',
      key_questions: ['当前流程的瓶颈在哪里', '哪些重复性工作可以自动化', '协作中的信息损耗如何减少'],
      non_goals: ['不做具体工具的使用手册', '不替代项目管理系统'],
      research_boundary: '聚焦流程设计和协作模式，不深入具体工具的配置细节',
      priority_signals: ['流程改进', '效率提升', '协作模式', '自动化'],
    },
  ];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO domain_goals (domain_id, purpose, key_questions, non_goals, research_boundary, priority_signals, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  for (const g of goals) {
    insertStmt.run(
      g.domain_id, g.purpose,
      JSON.stringify(g.key_questions), JSON.stringify(g.non_goals),
      g.research_boundary, JSON.stringify(g.priority_signals),
      now, now
    );
    console.log(`  + ${g.domain_id}: ${g.purpose}`);
  }

  console.log(`\nDomain goals created.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== KIVO Data Layer Activation ===');
  console.log(`DB: ${DB_PATH}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  try {
    await backfillSimilarSentences(db);
    await generateResearchTasks(db);
    await ensureDomainGoals(db);

    // Final verification
    console.log('\n═══ Final Verification ═══\n');
    const stats = {
      intents_total: db.prepare('SELECT COUNT(*) as c FROM intents WHERE status="active"').get().c,
      intents_with_similar: db.prepare('SELECT COUNT(*) as c FROM intents WHERE similar_sentences_json != "[]" AND similar_sentences_json IS NOT NULL AND similar_sentences_json != ""').get().c,
      entries_intent_total: db.prepare('SELECT COUNT(*) as c FROM entries WHERE type="intent"').get().c,
      entries_with_similar: db.prepare('SELECT COUNT(*) as c FROM entries WHERE type="intent" AND similar_sentences != "[]" AND similar_sentences IS NOT NULL AND similar_sentences != ""').get().c,
      research_tasks: db.prepare('SELECT COUNT(*) as c FROM research_tasks').get().c,
      domain_goals: db.prepare('SELECT COUNT(*) as c FROM domain_goals').get().c,
    };

    console.log(`intents table: ${stats.intents_with_similar}/${stats.intents_total} have similar_sentences`);
    console.log(`entries(intent): ${stats.entries_with_similar}/${stats.entries_intent_total} have similar_sentences`);
    console.log(`research_tasks: ${stats.research_tasks}`);
    console.log(`domain_goals: ${stats.domain_goals}`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
