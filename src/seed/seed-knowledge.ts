import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { KnowledgeType } from '../types/index.js';

interface SeedEntry {
  type: KnowledgeType;
  title: string;
  content: string;
  tags: string[];
  domain?: string;
  confidence: number;
}

const SEED_ENTRIES: SeedEntry[] = [
  {
    type: 'fact',
    title: 'KIVO 快速入门',
    content: '欢迎使用 KIVO！这是你的第一条知识。\n\n## 核心概念\n- **知识条目**：KIVO 管理的最小知识单元\n- **知识类型**：事实、决策、方法论、经验、意图、元知识\n- **双向链接**：用 [[标题]] 语法链接知识条目\n\n## 试试这些\n1. 点击左侧「知识库」查看所有条目\n2. 在编辑器中输入 [[ 试试双链搜索\n3. 输入 / 打开命令面板\n4. 查看「图谱」页面看知识关系网络\n\n相关：[[为什么选择 KIVO]]、[[知识管理方法论]]',
    tags: ['getting-started', 'kivo'],
    domain: 'kivo',
    confidence: 0.95,
  },
  {
    type: 'decision',
    title: '为什么选择 KIVO',
    content: 'KIVO 和传统笔记工具的区别：知识不只是存储，还会自动迭代、冲突检测、关联发现。\n\n传统笔记工具（Obsidian、Notion、Mem）解决的是"记录"问题，KIVO 解决的是"知识演化"问题：\n- 知识有置信度，会随证据更新\n- 冲突的知识会被自动检测\n- Agent 能理解你的知识上下文\n\n参见：[[KIVO 快速入门]]、[[常见知识管理陷阱]]',
    tags: ['decision', 'kivo', 'comparison'],
    domain: 'kivo',
    confidence: 0.9,
  },
  {
    type: 'methodology',
    title: '知识管理方法论',
    content: '好的知识管理遵循：提取→结构化→关联→迭代→应用 的闭环。\n\n1. **提取**：从阅读、对话、实践中捕获原始信息\n2. **结构化**：分类为事实/决策/方法论/经验/意图/元知识\n3. **关联**：用 [[双向链接]] 建立知识网络\n4. **迭代**：定期审视，更新置信度，标记过时知识\n5. **应用**：让 Agent 在工作中注入相关知识上下文\n\n避免：[[常见知识管理陷阱]]\n实践：[[KIVO 意图理解示例]]',
    tags: ['methodology', 'knowledge-management'],
    domain: 'productivity',
    confidence: 0.85,
  },
  {
    type: 'experience',
    title: '常见知识管理陷阱',
    content: '1. **只存不用**：知识库变成垃圾场，定期清理比疯狂收集更重要\n2. **不建链接**：知识孤岛，每条知识至少链接一条相关条目\n3. **不清理过期知识**：过时的"事实"比没有知识更危险\n4. **分类强迫症**：花太多时间在分类上，不如先写下来再整理\n5. **工具焦虑**：换工具不等于做知识管理\n\nKIVO 的设计就是为了降低这些陷阱的门槛——参见 [[为什么选择 KIVO]]、[[知识管理方法论]]',
    tags: ['experience', 'knowledge-management', 'pitfalls'],
    domain: 'productivity',
    confidence: 0.8,
  },
  {
    type: 'intent',
    title: 'KIVO 意图理解示例',
    content: 'KIVO 能理解你的意图并注入相关知识上下文。试试问 Agent 一个领域问题，它会自动检索你的知识库。\n\n例如：\n- "帮我写一份技术方案" → Agent 会参考你的 [[知识管理方法论]] 和相关决策\n- "这个 bug 之前遇到过吗" → Agent 会搜索你的经验类知识\n- "我们为什么选了这个方案" → Agent 会找到相关的决策记录\n\n开始使用：[[KIVO 快速入门]]',
    tags: ['intent', 'agent', 'kivo'],
    domain: 'kivo',
    confidence: 0.7,
  },
  {
    type: 'meta',
    title: '如何用好 KIVO 的六种知识类型',
    content: '知识类型是 KIVO 的核心分类维度，选对类型能让 Agent 更精准地理解和检索你的知识。\n\n- **事实（fact）**：客观信息，如"Node.js 22 支持 ESM"\n- **决策（decision）**：选择及其理由，如 [[为什么选择 KIVO]]\n- **方法论（methodology）**：可复用的做事方法，如 [[知识管理方法论]]\n- **经验（experience）**：踩坑和教训，如 [[常见知识管理陷阱]]\n- **意图（intent）**：用户意图的正例/负例，帮助 Agent 理解你的表达习惯\n- **元知识（meta）**：关于知识本身的知识，比如这条就是元知识\n\n不确定选哪个？先写下来，后面再调整类型。参见 [[KIVO 快速入门]]',
    tags: ['meta', 'knowledge-types', 'guide'],
    domain: 'kivo',
    confidence: 0.85,
  },
];

export function seedKnowledge(dbPath: string): number {
  const db = new Database(dbPath);
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
  if (existing.cnt > 0) {
    db.close();
    return 0;
  }

  const insert = db.prepare(`
    INSERT INTO entries (id, type, title, content, summary, source_json, confidence, status, tags_json, domain, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((entries: SeedEntry[]) => {
    for (const entry of entries) {
      const id = randomUUID();
      const source = JSON.stringify({ type: 'system', reference: 'kivo:seed', timestamp: now });
      const summary = entry.content.slice(0, 80);
      insert.run(id, entry.type, entry.title, entry.content, summary, source, entry.confidence, 'active', JSON.stringify(entry.tags), entry.domain ?? null, 1, now, now);
    }
  });

  insertMany(SEED_ENTRIES);
  db.close();
  return SEED_ENTRIES.length;
}
