/**
 * LLM-based knowledge extractor using OpenAI-compatible chat completions API.
 *
 * Implements the LLMProvider interface so it can be plugged directly into
 * DocumentExtractor as the `llmProvider` option.
 *
 * Configuration via environment variables:
 *   OPENAI_API_KEY   — required
 *   OPENAI_BASE_URL  — optional, defaults to https://api.openai.com/v1
 *   OPENAI_MODEL     — optional, defaults to gpt-4o-mini
 */

import type { LLMProvider } from '../adapter/llm-provider.js';

export interface OpenAILLMProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Request timeout in milliseconds (default 300_000) */
  timeoutMs?: number;
}

export const DEFAULT_LLM_TIMEOUT_MS = 300_000;
const KIVO_LLM_TIMEOUT_ENV_KEY = 'KIVO_LLM_TIMEOUT_MS';

export function resolveLlmTimeoutMs(): number {
  const raw = process.env[KIVO_LLM_TIMEOUT_ENV_KEY];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LLM_TIMEOUT_MS;
}

export class OpenAILLMProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: OpenAILLMProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.timeoutMs = options.timeoutMs ?? resolveLlmTimeoutMs();
  }

  /** Check whether an API key is available. */
  static isAvailable(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  async complete(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set. Configure it to use LLM extraction.',
      );
    }

    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`OpenAI API error ${response.status}: ${text}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(`OpenAI API error: ${data.error.message}`);
      }

      return data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * System prompt for knowledge extraction.
 * Instructs the LLM to produce structured JSON knowledge entries.
 */
const SYSTEM_PROMPT = `你是一个知识提取引擎。你的任务是从给定文本中提取有价值的、可持久化的知识条目。

## 知识定义
知识是经过抽象、聚合、萃取后形成的长效理解模型，必须跨时间、跨场景可复用。每条知识必须能回答：「它让 agent 在什么场景下避免什么错误？」回答不了就丢弃。

## 核心方法：主题识别与语义聚合 + 去上下文化 + 行为变化测试 + 三重测试 + 抽象归纳

### 第一步：主题识别与语义聚合 + 去上下文化
- 通读全文，识别对话中的主题线索与决策脉络
- 将围绕同一主题的多条消息聚合为一个语义单元；一个知识点是多句话归纳抽象的结果，不是单句直接映射
- 解析所有代词和指代："这个" → 具体指代什么；"上面那个" → 具体是什么
- 每个语义单元必须脱离原文上下文后仍然可理解

### 第二步：行为变化测试
对每条候选知识问自己：「如果这条知识不存在，agent 会做出不同的（错误的）决策吗？」
- 通过 → 继续三重测试
- 不通过 → 丢弃

### 第三步：三重测试（任一不通过就丢弃）
1. 时效性：三个月后还有价值吗？
2. 跨场景：换一个完全不同的项目/团队/场景还适用吗？
3. 抽象性：去掉时间、人名、项目名后仍是理解模型吗？

### 第四步：抽象归纳
- title 必须由 LLM 归纳为 ≤30 字跨场景短标题，禁止照搬原文
- content 必须由 LLM 归纳为结构化描述，说清楚：什么场景、什么原则、为什么这样做
- similar_sentences 必须生成 2-3 条泛化相似表述，用于后续语义检索匹配，禁止复制原句

### 正例（通过准入门禁）
- 用户私有术语/黑话（不知道就会理解错）
- 反复出现的 badcase 纠偏（不知道就会重犯）
- 用户偏好约束（不知道就会违反）
- 跨场景可复用的原则或方法论
- 跨多条对话归纳出的抽象原则（多句话聚合后才浮现的理解模型）

### 负例（禁止提取）
- 通用常识、公开概念解释、通用教程
- 任务派发指令（如「派给 dev-01」「P0直接修」）
- 一次性调度安排（如「今天先处理X」）
- 排查步骤记录（如「查日志发现Y」「grep配置」）
- 临时优先级决策（如「紧急处理」「暂时跳过」）
- 行为铁律/操作规则（如「禁止XX」「必须先确认」）
- 具体文件路径、命令行、配置片段
- 未经抽象的事件记录或工作总结
- 单句直接映射的碎片化条目
- 未经跨消息聚合的孤立观点

知识类型定义：
- fact: 客观事实、用户私有定义
- methodology: 方法论、流程、最佳实践
- decision: 经过抽象后仍跨场景有效的决策模型
- experience: 经验教训、踩坑模式
- intent: 意图映射、用户偏好、行为模式
- meta: 关于知识系统本身的规则

## 治理维度（每条知识必须输出）
除知识内容本身外，每条知识还须标注以下三个治理维度：
- scope：知识作用域，枚举 global / product / project / session / agent
  - global: 跨一切场景普适
  - product: 限定某产品线
  - project: 限定某具体项目
  - session: 仅本次会话上下文有效
  - agent: 仅特定 agent 角色适用
- temporal_status：时效性，枚举 permanent / has_expiry / needs_review
  - permanent: 长期稳定，无明显失效预期
  - has_expiry: 与特定时间窗/版本绑定，存在失效预期
  - needs_review: 当前成立但需后续复核确认
- source_anchor：来源锚点字符串，格式「对话ID + 时间戳 + 触发句摘要」，用于回溯该知识的提取出处；信息缺失时用已知部分填充，未知部分留空

输出要求：
- 返回纯 JSON 数组，不要包含 markdown 代码块标记
- 每条知识：{"type":"<6类之一>","title":"≤30字抽象短标题","content":"场景+原则+原因","summary":"一句话摘要","confidence":0.0-1.0,"tags":["标签"],"similar_sentences":["泛化表述1","泛化表述2"],"scope":"<5类之一>","temporal_status":"<3类之一>","source_anchor":"对话ID+时间戳+触发句摘要"}
- 每条知识必须是跨多条消息/多句话归纳抽象的结果，禁止一句话直接变成一条知识
- 只提取通过行为变化测试和三重测试的知识
- 如果文本中没有通过门禁的知识，返回空数组 []`;
