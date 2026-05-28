/**
 * finish-activation.mjs — Complete remaining backfill + research_tasks + domain_goals
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

const DB_PATH = '/root/.openclaw/workspace/projects/kivo/kivo.db';
const CONFIG_PATH = '/root/.openclaw/openclaw.json';

function getProvider() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const p = cfg.models?.providers?.['penguin-main'];
  return { baseUrl: p.baseUrl.replace(/\/$/, ''), apiKey: p.apiKey };
}

async function callLlm(messages, { model = 'claude-opus-4-6', maxTokens = 1200, temperature = 0.7 } = {}) {
  const provider = getProvider();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  } catch (err) { clearTimeout(timer); throw err; }
}

function parseJsonArray(raw) {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  try { const p = JSON.parse(cleaned); if (Array.isArray(p)) return p.filter(s => typeof s === 'string' && s.trim()).slice(0, 15); } catch {}
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) { try { const a = JSON.parse(m[0]); if (Array.isArray(a)) return a.filter(s => typeof s === 'string').slice(0, 15); } catch {} }
  return [];
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─── Finish remaining entries ─────────────────────────────────────────────────
const remaining = db.prepare(`
  SELECT id, title, content FROM entries
  WHERE type = 'intent' AND (similar_sentences IS NULL OR similar_sentences = '[]' OR similar_sentences = '')
`).all();

console.log(`Remaining entries to backfill: ${remaining.length}`);

for (let i = 0; i < remaining.length; i++) {
  const row = remaining[i];
  try {
    const prompt = `你是一个意图理解专家。给定以下意图知识条目，请生成 7 条用户可能说出的、表达同一意图的不同自然语言句子。\n\n意图标题: ${row.title}\n意图内容: ${row.content}\n\n要求：\n- 多样化表达（口语/书面、简短/详细）\n- 每条是独立用户输入\n- 返回纯 JSON 数组 ["句子1", "句子2", ...]`;
    const raw = await callLlm([{ role: 'user', content: prompt }]);
    const sentences = parseJsonArray(raw);
    if (sentences.length > 0) {
      db.prepare('UPDATE entries SET similar_sentences = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(sentences), new Date().toISOString(), row.id);
      console.log(`  [${i+1}/${remaining.length}] OK (${sentences.length}): ${row.title}`);
    } else {
      console.log(`  [${i+1}/${remaining.length}] FAIL parse: ${row.title}`);
    }
  } catch (err) {
    console.log(`  [${i+1}/${remaining.length}] ERROR: ${row.title} — ${err.message}`);
  }
  if (i < remaining.length - 1) await new Promise(r => setTimeout(r, 1500));
}

// ─── Research tasks ───────────────────────────────────────────────────────────
console.log('\n--- Research Tasks ---');
const rtCount = db.prepare('SELECT COUNT(*) as c FROM research_tasks').get().c;
if (rtCount >= 5) {
  console.log(`Already have ${rtCount} research tasks.`);
} else {
  const topIntents = db.prepare("SELECT name FROM intents WHERE status='active' ORDER BY hit_count DESC LIMIT 8").all();
  const orphans = db.prepare(`
    SELECT gn.title as label, gn.type FROM graph_nodes gn
    LEFT JOIN graph_edges ge1 ON gn.entry_id = ge1.source_id
    LEFT JOIN graph_edges ge2 ON gn.entry_id = ge2.target_id
    WHERE ge1.source_id IS NULL AND ge2.target_id IS NULL LIMIT 8
  `).all();

  const ctx = `高频意图: ${topIntents.map(i=>i.name).join(', ')}\n孤立图节点: ${orphans.map(n=>`${n.label}(${n.type})`).join(', ') || '无'}`;

  const prompt = `你是知识管理专家。基于以下知识库现状，生成 6 条调研任务。任务应帮助填补知识缺口、优化系统。

${ctx}

要求：
- 每条: {"title":"简短标题", "description":"详细描述", "scope":"调研范围", "priority":"high/medium/low"}
- 通用方向（系统优化、流程改进、知识治理等），不涉及具体学科
- 返回 JSON 数组`;

  try {
    const raw = await callLlm([{ role: 'user', content: prompt }], { maxTokens: 2000 });
    let cleaned = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    const match = cleaned.match(/\[[\s\S]*\]/);
    let tasks = [];
    if (match) { try { tasks = JSON.parse(match[0]); } catch {} }
    if (!tasks.length) { try { tasks = JSON.parse(cleaned); } catch {} }

    const stmt = db.prepare(`INSERT INTO research_tasks (id, title, description, scope, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`);
    const now = Date.now();
    let inserted = 0;
    for (const t of tasks) {
      if (!t.title) continue;
      stmt.run(crypto.randomUUID(), t.title, t.description || '', t.scope || '', t.priority || 'medium', now, now);
      console.log(`  + ${t.title} [${t.priority}]`);
      inserted++;
    }
    console.log(`Inserted ${inserted} research tasks.`);
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
}

// ─── Domain goals ─────────────────────────────────────────────────────────────
console.log('\n--- Domain Goals ---');
const goalCount = db.prepare('SELECT COUNT(*) as c FROM domain_goals').get().c;
if (goalCount >= 2) {
  console.log(`Already have ${goalCount} domain goals.`);
} else {
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
  const stmt = db.prepare(`INSERT OR IGNORE INTO domain_goals (domain_id, purpose, key_questions, non_goals, research_boundary, priority_signals, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = new Date().toISOString();
  for (const g of goals) {
    stmt.run(g.domain_id, g.purpose, JSON.stringify(g.key_questions), JSON.stringify(g.non_goals), g.research_boundary, JSON.stringify(g.priority_signals), now, now);
    console.log(`  + ${g.domain_id}`);
  }
}

// ─── Final stats ──────────────────────────────────────────────────────────────
console.log('\n=== FINAL STATS ===');
console.log(`intents with similar: ${db.prepare("SELECT COUNT(*) as c FROM intents WHERE similar_sentences_json != '[]' AND similar_sentences_json IS NOT NULL").get().c} / ${db.prepare("SELECT COUNT(*) as c FROM intents WHERE status='active'").get().c}`);
console.log(`entries(intent) with similar: ${db.prepare("SELECT COUNT(*) as c FROM entries WHERE type='intent' AND similar_sentences != '[]' AND similar_sentences IS NOT NULL AND similar_sentences != ''").get().c} / ${db.prepare("SELECT COUNT(*) as c FROM entries WHERE type='intent'").get().c}`);
console.log(`research_tasks: ${db.prepare("SELECT COUNT(*) as c FROM research_tasks").get().c}`);
console.log(`domain_goals: ${db.prepare("SELECT COUNT(*) as c FROM domain_goals").get().c}`);

db.close();
