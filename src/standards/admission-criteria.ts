/**
 * Admission Criteria — Single Source of Truth for knowledge quality gates.
 *
 * Both the extraction pipeline and governance pipeline import from here.
 * Change once, both sides pick up the new standard automatically.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Config-driven thresholds ─────────────────────────────────────────────────

/** Default dedup cosine similarity threshold */
export const DEFAULT_DEDUP_THRESHOLD = 0.92;

/**
 * Load the dedup threshold from kivo.config.json.
 * Re-reads on every call (hot-reload).
 */
export function loadDedupThreshold(configDir?: string): number {
  const dir = configDir ?? process.cwd();
  const configPath = join(dir, 'kivo.config.json');
  try {
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      const t = cfg?.extraction?.dedup?.threshold;
      if (typeof t === 'number' && t > 0 && t <= 1) return t;
    }
  } catch { /* non-fatal */ }
  return DEFAULT_DEDUP_THRESHOLD;
}

// ── Knowledge definition / admission boundary ────────────────────────────────

export const KNOWLEDGE_ADMISSION_BOUNDARY_PROMPT = `### 知识定义与准入边界
知识是经过抽象、聚合、萃取后形成的长效理解模型。它必须跨时间、跨场景可复用；缺了它，agent 会在未来做出系统性错误判断。
每条知识必须能回答：「它让 agent 在什么场景下避免了什么错误？」回答不了就不该入库。

以下内容不是知识，禁止入库：任务派发指令、一次性调度安排、排查步骤记录、临时优先级决策、行为铁律/操作规则、具体文件路径、命令行、配置片段、未经抽象的决策记录。`;

export const TRIPLE_TEST_PROMPT = `### 三重测试（全部通过才允许入库）
1. 时效性测试：「这条信息三个月后还有效吗？」
2. 跨场景测试：「换一个完全不同的项目/场景，它还适用吗？」
3. 抽象性测试：「这条信息是可复用的理解模型，而不是操作指令吗？去掉时间、人名、项目名等具体上下文后，它是否仍有指导价值？」
任一问题回答为否，必须拒绝入库。三重测试必须由 LLM 语义判断执行，禁止用关键词匹配、正则、FTS5 或规则引擎承担语义理解职责。`;

/**
 * Positive examples that pass the behavioral change and triple tests.
 */
export const BEHAVIORAL_CHANGE_POSITIVE_EXAMPLES = [
  '用户私有术语/黑话（不知道就会理解错）',
  '反复出现的 badcase 纠偏（不知道就会重犯）',
  '用户偏好约束（不知道就会违反）',
  '容易被上下文稀释的关键约束（不强调就会忘）',
  '跨场景可复用的原则（例如：关键词匹配不能承担语义理解职责）',
  '长效有效的方法论（例如：修复问题先堵根因再修症状）',
  '抽象的理解模型（例如：LLM 始终可用，不设计无 LLM 降级路径）',
];

/**
 * Negative examples that fail the behavioral change and triple tests.
 */
export const BEHAVIORAL_CHANGE_NEGATIVE_EXAMPLES = [
  '通用常识（任何 LLM 都知道）',
  '概念解释/定义（查文档就有）',
  '通用方法论教程（不是用户私有的）',
  '非私有事实描述（公开信息）',
  '纯操作性内容（帮我打开文件）',
  '临时性对话（闲聊、确认收到）',
  '行为铁律/操作规则（例如：禁止XX、必须先确认、P0直接修）',
  '任务派发指令（例如：派pm-01去改spec、交给dev-01修）',
  '一次性调度安排（例如：先做A再做B、codex去做这个）',
  '临时优先级排序（例如：今天优先处理官网、KIVO优先级高于AEO）',
  '排查步骤记录（例如：加日志定位根因、grep查配置、openclaw doctor报错）',
  '临时决策/执行层决策（例如：紧急处理、暂时跳过、这个先不做）',
  '具体文件路径、命令行、配置片段（例如：~/...、systemctl restart、JSON/YAML）',
  '未经抽象的事件记录（例如：今天cc超时了、boom provider挂了）',
  '配置描述（例如：当前用penguin provider、agent池有12个）',
  '待办事项（例如：需要加个监控脚本）',
];

// ── Behavioral Change Test ───────────────────────────────────────────────────

/**
 * The core admission gate prompt fragment.
 * Used by both extraction (to decide what to extract) and governance (to decide what to keep).
 */
export const BEHAVIORAL_CHANGE_TEST_PROMPT = `### 行为变化测试（准入门禁）
对每条候选知识问自己：「如果这条知识不存在，agent 会做出不同的（错误的）决策吗？」
- 通过 → 继续执行三重测试
- 不通过 → 丢弃，不管内容多有趣`;

export function buildKnowledgeAdmissionBoundarySection(): string {
  return `${KNOWLEDGE_ADMISSION_BOUNDARY_PROMPT}

${TRIPLE_TEST_PROMPT}`;
}

/**
 * Build the full behavioral change test section for prompts.
 * Used in both extraction and governance contexts.
 */
export function buildBehavioralChangeTestSection(): string {
  const positives = BEHAVIORAL_CHANGE_POSITIVE_EXAMPLES
    .map(e => `- ${e}`)
    .join('\n');
  const negatives = BEHAVIORAL_CHANGE_NEGATIVE_EXAMPLES
    .map(e => `- ${e}`)
    .join('\n');

  return `${BEHAVIORAL_CHANGE_TEST_PROMPT}

${TRIPLE_TEST_PROMPT}

### 正例（通过行为变化测试和三重测试）
${positives}

### 负例（不通过行为变化测试或三重测试，禁止提取/入库）
${negatives}`;
}

// ── Governance-specific prompt ───────────────────────────────────────────────

/**
 * Prompt for governance to evaluate whether an existing entry still passes
 * the behavioral change and triple tests. Returns structured JSON.
 */
export const GOVERNANCE_BEHAVIORAL_TEST_PROMPT = `你是一个知识质量评估引擎。对给定的知识条目执行「行为变化测试」和「三重测试」。

${buildKnowledgeAdmissionBoundarySection()}

${BEHAVIORAL_CHANGE_TEST_PROMPT}

### 正例（通过准入门禁）
${BEHAVIORAL_CHANGE_POSITIVE_EXAMPLES.map(e => `- ${e}`).join('\n')}

### 负例（不通过准入门禁，应标记为 stale）
${BEHAVIORAL_CHANGE_NEGATIVE_EXAMPLES.map(e => `- ${e}`).join('\n')}

对给定知识条目，判断：如果这条知识不存在，agent 会在什么未来场景做出什么错误决策？三个月后是否仍有效？换项目是否仍适用？它是抽象理解模型还是操作指令？去掉具体上下文是否仍有指导价值？

返回纯 JSON：
{
  "passes": true/false,
  "confidence": 0.0-1.0,
  "tripleTest": {
    "timeliness": true/false,
    "crossScenario": true/false,
    "abstractness": true/false,
    "behaviorImpact": true/false
  },
  "avoidsError": "它让 agent 在什么场景下避免什么错误",
  "reasoning": "一句话理由"
}
不要包含 markdown 代码块标记。`;
