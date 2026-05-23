import type { ConversationMessage } from '../extraction/conversation-extractor.js';
import type { IntentSignalType, SignalTypeDefinition } from './signal-types.js';

function formatExamples(label: string, examples: string[]): string {
  if (examples.length === 0) return `${label}: 无`;
  return `${label}:\n${examples.map((example, index) => `  ${index + 1}. ${example}`).join('\n')}`;
}

function formatTypeDefinition(definition: SignalTypeDefinition): string {
  const custom = definition.promptFragment ? `\n补充检测说明: ${definition.promptFragment}` : '';
  return `- ${definition.type}\n  定义: ${definition.description}\n  ${formatExamples('正例', definition.positiveExamples)}\n  ${formatExamples('负例', definition.negativeExamples)}${custom}`;
}

function buildTypeSection(definitions: SignalTypeDefinition[]): string {
  return definitions.map(formatTypeDefinition).join('\n\n');
}

function buildOutputSchema(enabledTypes: IntentSignalType[]): string {
  return `输出纯 JSON 数组。type 只能使用以下值之一：${enabledTypes.join('|')}。
每条格式：
[{
  "type": "${enabledTypes.join('|')}",
  "confidence": 0.0-1.0,
  "title": "简短描述性标题（不超过50字符）",
  "content": "需要记住的知识陈述",
  "positives": ["正确行为示例"],
  "negatives": ["错误行为示例"],
  "sourceFragment": "触发此信号的原始对话片段引用",
  "reason": "一句话说明为什么判定为该类型",
  "tags": ["相关", "标签"]
}]

如果没有检测到任何信号，返回空数组 []。`;
}

/**
 * Build the LLM prompt for detecting intent signals from a conversation transcript.
 */
export function buildDetectionPrompt(
  messages: ConversationMessage[],
  enabledTypes: IntentSignalType[],
  definitions: SignalTypeDefinition[],
): string {
  const transcript = messages
    .map((m, i) => `[${i}] ${m.role}: ${m.content}`)
    .join('\n');

  return `你是一个意图信号检测专家。分析以下对话，检测用户表达的意图信号。信号是应该被记住、用于改善未来交互的纠偏、强调、声明、规则、偏好、决策、约束、经验教训、事实更新或自定义类型信息。

要检测的信号类型：
${buildTypeSection(definitions)}

检测要求：
1. 基于语义理解判断，不要做简单关键词匹配、正则或 FTS5。
2. 同一句话可能包含多种信号，例如“禁止用 var，我习惯用 const”同时包含 constraint 和 preference。
3. confidence 反映信号明确程度：直接明确表达 >= 0.8，间接暗示 0.6-0.8，模糊推测 < 0.6。
4. 提取正例（应该做什么）和反例（不应该做什么）。
5. sourceFragment 必须是对话中的原文引用。
6. reason 用一句话解释判定依据，不能只复述类型名。

${buildOutputSchema(enabledTypes)}

对话内容：
${transcript}`;
}

/**
 * Build a simplified prompt for single-message signal detection.
 * Optimized for real-time detection on individual messages.
 */
export function buildSingleMessageDetectionPrompt(
  message: string,
  enabledTypes: IntentSignalType[],
  definitions: SignalTypeDefinition[],
): string {
  return `你是一个意图信号检测专家。分析以下用户消息，检测其中的意图信号。信号是应该被记住、用于改善未来交互的信息。

要检测的信号类型：
${buildTypeSection(definitions)}

检测要求：
1. 基于语义理解判断，不要做简单关键词匹配、正则或 FTS5。
2. 同一条消息可能包含多种信号。
3. confidence 反映信号明确程度：直接明确表达 >= 0.8，间接暗示 0.6-0.8。
4. 提取正例（应该做什么）和反例（不应该做什么）。
5. sourceFragment 必须是消息中的原文片段。
6. reason 用一句话解释判定依据。

${buildOutputSchema(enabledTypes)}

用户消息：
${message}`;
}
