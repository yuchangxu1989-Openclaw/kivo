/**
 * Classifier — LLM-based knowledge type classifier.
 * Assigns one of six types (ADR-006) to extracted content via semantic understanding.
 *
 * Uses OpenAI-compatible chat completions API through the shared LLM config resolver.
 */

import type { KnowledgeType } from '../types/index.js';
import { OpenAILLMProvider } from '../extraction/llm-extractor.js';
import { resolveLlmConfig } from '../cli/resolve-llm-config.js';
import { shouldBypassExternalModelsInTests } from '../utils/test-runtime.js';

export interface ClassificationResult {
  type: KnowledgeType;
  confidence: number;
  domain: string;
}

const CLASSIFICATION_PROMPT = `你是一个知识分类引擎。判断给定文本属于以下六种知识类型中的哪一种，并给出置信度和所属领域。

六种知识类型定义：

1. fact（事实知识）：客观事实、数据、定义、统计数字、可验证的陈述。
   示例："TypeScript 4.9 引入了 satisfies 运算符""SQLite WAL 模式支持并发读取""2024年全球AI市场规模达1840亿美元"

2. methodology（方法论）：流程、步骤、框架、最佳实践、设计模式、工作方法。
   示例："TDD 的三步循环：红-绿-重构""MECE 原则要求分类互斥且完全穷尽""微服务拆分应遵循单一职责原则"

3. decision（决策知识）：架构决策、技术选型、取舍权衡、ADR 记录。
   示例："选择 SQLite 而非 PostgreSQL，因为单机部署更简单""放弃 GraphQL 改用 REST，团队更熟悉""ADR-003: 采用事件驱动架构"

4. experience（经验知识）：实践经验、踩坑教训、实际发现、从错误中学到的。
   示例："生产环境发现连接池设为5太小，改成20后延迟降了60%""之前用正则做分类效果很差，换成LLM后准确率提升明显"

5. intent（意图知识）：目标、愿景、规则、约束、禁止事项、期望行为。
   示例："禁止在主分支直接提交""所有API必须有认证""产品目标是让用户5分钟内上手"

6. meta（元知识）：关于知识本身的知识、认知反思、思维方式、知识管理方法。
   示例："我们对这个领域的理解还很浅，需要更多实验""这条规则的置信度不高，来源单一""知识图谱的边代表因果关系而非相关性"

领域判断规则：
- engineering：涉及代码、架构、技术、工程实践
- business：涉及用户、市场、增长、运营、商业
- governance：涉及规则、规范、知识管理、Agent 行为约束
- general：无法归入以上三类

返回纯 JSON，格式：{"type": "类型名", "confidence": 0.0-1.0, "domain": "领域名"}
不要包含 markdown 代码块标记，不要解释。`;

// Lazy-initialized LLM provider singleton
let _llmProvider: OpenAILLMProvider | null = null;

function getLlmProvider(): OpenAILLMProvider {
  if (!_llmProvider) {
    const config = resolveLlmConfig();
    if ('error' in config) {
      throw new Error(config.error);
    }
    _llmProvider = new OpenAILLMProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: 30_000,
    });
  }
  return _llmProvider;
}

function parseClassificationResponse(raw: string): ClassificationResult | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    const validTypes: KnowledgeType[] = ['fact', 'methodology', 'decision', 'experience', 'intent', 'meta'];
    const validDomains = ['engineering', 'business', 'governance', 'general'];

    const type = validTypes.includes(parsed.type) ? parsed.type : null;
    if (!type) return null;

    const confidence = typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.7;

    const domain = validDomains.includes(parsed.domain) ? parsed.domain : 'general';

    return { type, confidence, domain };
  } catch {
    return null;
  }
}

function inferTestClassification(content: string): ClassificationResult {
  const text = content.trim();

  if (/目标|必须|禁止|约束|规则|要求|should|must|forbid/i.test(text)) {
    return { type: 'intent', confidence: 0.9, domain: 'governance' };
  }
  if (/元认知|反思|自省|认知|知识管理|方法论本身/i.test(text)) {
    return { type: 'meta', confidence: 0.88, domain: 'governance' };
  }
  if (/决定|放弃|取舍|权衡|采用|选择/i.test(text)) {
    return { type: 'decision', confidence: 0.88, domain: 'engineering' };
  }
  if (/最佳实践|步骤|流程|框架|方案|practice|process|guide/i.test(text)) {
    return { type: 'methodology', confidence: 0.86, domain: 'engineering' };
  }
  if (/实践|踩坑|经验|教训|问题|故障|复盘|发现/i.test(text)) {
    return { type: 'experience', confidence: 0.84, domain: 'engineering' };
  }
  if (/\d|数据|统计|占比|增长|定义|事实|说明|content|artifact|research/i.test(text)) {
    return { type: 'fact', confidence: 0.82, domain: inferTestDomain(text) };
  }

  return { type: 'fact', confidence: 0.8, domain: inferTestDomain(text) };
}

function inferTestDomain(content: string): string {
  if (/代码|架构|工程|TypeScript|JavaScript|Rust|API|database|sql|pipeline|build|deploy|test|artifact/i.test(content)) {
    return 'engineering';
  }
  if (/用户|市场|增长|运营|商业|business|growth/i.test(content)) {
    return 'business';
  }
  if (/规则|规范|治理|知识|agent|governance/i.test(content)) {
    return 'governance';
  }
  return 'general';
}

export class Classifier {
  /**
   * Classify text content into one of six knowledge types using LLM semantic understanding.
   * Returns the best match with confidence score and domain.
   */
  async classify(content: string): Promise<ClassificationResult> {
    if (shouldBypassExternalModelsInTests()) {
      return inferTestClassification(content);
    }

    const llm = getLlmProvider();
    const truncated = content.length > 3000 ? content.slice(0, 3000) : content;

    const prompt = `${CLASSIFICATION_PROMPT}\n\n文本：\n${truncated}`;
    const raw = await llm.complete(prompt);
    const result = parseClassificationResponse(raw);

    if (result) {
      return result;
    }

    // LLM returned unparseable response — return low-confidence default
    return { type: 'fact', confidence: 0.3, domain: 'general' };
  }
}
