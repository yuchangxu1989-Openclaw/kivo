/**
 * DocPackage — 用户文档交付包
 *
 * FR-Z05:
 * - AC1: 提供 README、Quick Start、配置参考、故障排查文档
 * - AC2: 文档内容与当前版本功能一致
 * - AC3: Quick Start 可在 5 分钟内完成
 */

export interface DocSection {
  id: string;
  title: string;
  content: string;
}

export interface DocPackage {
  version: string;
  sections: DocSection[];
  generatedAt: string;
}

/**
 * 生成用户文档交付包
 */
export function generateDocPackage(version: string): DocPackage {
  return {
    version,
    generatedAt: new Date().toISOString(),
    sections: [
      generateReadme(version),
      generateQuickStart(),
      generateConfigReference(),
      generateTroubleshooting(),
      generateUpgradeGuide(version),
    ],
  };
}

function generateReadme(version: string): DocSection {
  return {
    id: 'readme',
    title: 'README',
    content: `# KIVO — Agent 知识平台

KIVO 帮助 AI Agent 自主沉淀、检索和迭代领域知识。

## 核心能力

- 六种知识类型：事实、方法论、决策、经验、意图、元知识
- 语义搜索 + 关键词搜索双模式
- 自动冲突检测与解决
- 知识域隔离与访问控制
- 批量导入导出
- 域目标驱动的知识治理

## 安装

\`\`\`bash
npm install @self-evolving-harness/kivo
\`\`\`

## 快速开始

\`\`\`typescript
import { Kivo } from '@self-evolving-harness/kivo';

const kivo = new Kivo({ dbPath: './kivo.db' });
await kivo.init();

// 导入知识
await kivo.ingest('KIVO 支持六种知识类型...', 'manual');

// 检索知识
const results = await kivo.query('知识类型');
\`\`\`

版本: ${version}
`,
  };
}

function generateQuickStart(): DocSection {
  return {
    id: 'quick-start',
    title: '快速开始',
    content: `# 快速开始（5 分钟）

## 第 1 步：安装

\`\`\`bash
npm install @self-evolving-harness/kivo
\`\`\`

## 第 2 步：初始化

\`\`\`bash
npx kivo init
\`\`\`

这会在当前目录生成 \`kivo.config.json\` 配置文件。

## 第 3 步：启动并导入

\`\`\`typescript
import { Kivo } from '@self-evolving-harness/kivo';

const kivo = new Kivo({ dbPath: './kivo.db' });
await kivo.init();

// 导入一条知识
const result = await kivo.ingest(
  'TypeScript 的 strict 模式会启用所有严格类型检查选项',
  'quick-start'
);
console.log('导入成功:', result.entries.length, '条');
\`\`\`

## 第 4 步：检索验证

\`\`\`typescript
const hits = await kivo.query('TypeScript strict');
console.log('检索结果:', hits.length, '条');
\`\`\`

## 第 5 步：查看系统状态

\`\`\`bash
npx kivo health
\`\`\`
`,
  };
}

function generateConfigReference(): DocSection {
  return {
    id: 'config-reference',
    title: '配置参考',
    content: `# 配置参考

## kivo.config.json

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| dbPath | string | ./kivo.db | SQLite 数据库路径，":memory:" 为内存模式 |
| mode | string | standalone | 运行模式：standalone / hosted |
| conflictThreshold | number | 0.80 | 冲突检测相似度阈值 (0-1) |
| embedding.provider | string | - | Embedding 提供者：openai / local |
| embedding.options.apiKey | string | - | OpenAI API Key（建议用环境变量） |
| embedding.options.model | string | text-embedding-3-small | Embedding 模型 |
| embedding.options.dimensions | number | 1536 | 向量维度 |

## 环境变量

| 变量名 | 说明 |
|--------|------|
| KIVO_DB_PATH | 数据库路径（覆盖配置文件） |
| KIVO_MODE | 运行模式 |
| KIVO_EMBEDDING_PROVIDER | Embedding 提供者 |
| KIVO_EMBEDDING_API_KEY | Embedding API Key |
| KIVO_CONFLICT_THRESHOLD | 冲突检测阈值 |
`,
  };
}

function generateTroubleshooting(): DocSection {
  return {
    id: 'troubleshooting',
    title: '故障排查',
    content: `# 故障排查

## 常见问题

### 数据库初始化失败 (KIVO-STG-001)
- 原因：数据库路径不可写或 SQLite 版本不兼容
- 解决：确认 dbPath 目录存在且有写权限，或使用 ":memory:" 模式

### 配置校验失败 (KIVO-CFG-002)
- 原因：必填字段缺失或值不合法
- 解决：运行 \`npx kivo health\` 查看详细校验结果

### Embedding 不可用 (KIVO-EMB-001)
- 原因：未配置 Embedding Provider
- 解决：在配置中添加 embedding 配置，或使用关键词搜索

### 检索无结果 (KIVO-SCH-001)
- 原因：知识库为空或关键词不匹配
- 解决：导入数据后重试，或调整搜索关键词

### 登录失败 (KIVO-ATH-001)
- 原因：用户名或密码错误
- 解决：检查凭据，联系管理员重置密码

## 诊断命令

\`\`\`bash
# 环境校验
npx kivo check-env

# 系统健康检查
npx kivo health

# 查看系统能力
npx kivo capabilities
\`\`\`
`,
  };
}

export type UsagePath = 'standalone' | 'hosted' | 'full-stack';

export interface DocValidationResult {
  valid: boolean;
  sections: { id: string; present: boolean; hasContent: boolean }[];
  missingIds: string[];
}

const REQUIRED_SECTION_IDS = ['readme', 'quick-start', 'config-reference', 'troubleshooting', 'upgrade-guide'];

export function generateUpgradeGuide(version: string): DocSection {
  return {
    id: 'upgrade-guide',
    title: '升级说明',
    content: `# 升级说明

## ${version} 版本

### Breaking Changes

- 无

### 迁移步骤

1. 备份数据库文件
2. 更新依赖：\`npm install @self-evolving-harness/kivo@${version}\`
3. 运行迁移：\`npx kivo migrate\`
4. 验证：\`npx kivo health\`

### 已知兼容性问题

- 无
`,
  };
}

export function generateUsagePathDoc(path: UsagePath): DocSection {
  const docs: Record<UsagePath, DocSection> = {
    standalone: {
      id: 'usage-standalone',
      title: 'Standalone 模式',
      content: `# Standalone 模式

独立运行 KIVO，适合个人开发者或小团队。

\`\`\`bash
npx kivo init
npx kivo serve
\`\`\`
`,
    },
    hosted: {
      id: 'usage-hosted',
      title: '宿主嵌入模式',
      content: `# 宿主嵌入模式

将 KIVO 作为库嵌入到现有应用中。

\`\`\`typescript
import { Kivo } from '@self-evolving-harness/kivo';
const kivo = new Kivo({ dbPath: './kivo.db', mode: 'hosted' });
await kivo.init();
\`\`\`
`,
    },
    'full-stack': {
      id: 'usage-full-stack',
      title: 'Full-Stack 模式',
      content: `# Full-Stack 模式

前后端一体化部署，包含 Web 管理界面。

\`\`\`bash
npx kivo init --mode full-stack
npx kivo serve --port 3000
\`\`\`
`,
    },
  };
  return docs[path];
}

export function validateDocPackage(pkg: DocPackage): DocValidationResult {
  const sections = REQUIRED_SECTION_IDS.map(id => {
    const section = pkg.sections.find(s => s.id === id);
    return { id, present: !!section, hasContent: !!section && section.content.trim().length > 0 };
  });
  const missingIds = sections.filter(s => !s.present || !s.hasContent).map(s => s.id);
  return { valid: missingIds.length === 0, sections, missingIds };
}

/** 格式化文档包为 Markdown */
export function formatDocPackage(pkg: DocPackage): string {
  return pkg.sections.map(s => s.content).join('\n---\n\n');
}
