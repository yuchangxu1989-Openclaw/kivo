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
  /** Request timeout in milliseconds (default 60_000) */
  timeoutMs?: number;
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
    this.timeoutMs = options.timeoutMs ?? 60_000;
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

提取重点：
- 用户偏好和工作习惯
- 决策模式和决策依据
- 纠偏规则（当X发生时应该做Y，不应该做Z）
- 工作方法论和流程
- 经验教训（踩过的坑、成功的做法）
- 意图知识：「当用户说X时，实际想要Y」「用户偏好Z方式」
- 事实性知识（技术规格、配置要求、接口约定）
- 元知识（关于知识管理本身的规则）

知识类型定义：
- fact: 客观事实、技术规格、配置参数
- methodology: 方法论、流程、步骤、最佳实践
- decision: 决策记录、架构选择、取舍权衡
- experience: 经验教训、踩坑记录、成功案例
- intent: 意图映射、用户偏好、行为模式
- meta: 元知识、关于知识系统本身的规则

输出要求：
- 返回纯 JSON 数组，不要包含 markdown 代码块标记
- 每条知识：{"type":"<6类之一>","title":"简短标题（≤50字符）","content":"完整知识内容","summary":"一句话摘要","confidence":0.0-1.0,"tags":["标签"]}
- title 必须是简短标题，最长 50 个字符；不要把整段 content 原样复制进 title
- 只提取有持久价值的知识，跳过临时性、过于琐碎的内容
- confidence 反映知识的确定性和价值：0.9+ 明确规则/事实，0.7-0.9 有价值的经验，0.5-0.7 推测性知识
- 如果文本中没有可提取的知识，返回空数组 []`;
