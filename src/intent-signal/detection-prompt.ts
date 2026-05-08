import type { ConversationMessage } from '../extraction/conversation-extractor.js';
import type { IntentSignalType } from './signal-types.js';

export function buildDetectionPrompt(
  messages: ConversationMessage[],
  enabledTypes: IntentSignalType[],
): string {
  const transcript = messages
    .map((m, i) => `[${i}] ${m.role}: ${m.content}`)
    .join('\n');

  const typeDescriptions: Record<IntentSignalType, string> = {
    correction: 'User corrects a previous AI behavior or output (e.g., "no, I meant...", "don\'t do X")',
    emphasis: 'User emphasizes importance of something (e.g., "always", "make sure", "this is critical")',
    declaration: 'User declares a fact about themselves or their project (e.g., "I use TypeScript", "our API is REST")',
    rule: 'User states an explicit rule or constraint (e.g., "never use var", "all functions must be pure")',
    preference: 'User expresses a preference (e.g., "I prefer", "I like", "use X over Y")',
  };

  const enabledDesc = enabledTypes
    .map(t => `- ${t}: ${typeDescriptions[t]}`)
    .join('\n');

  return `Analyze the following conversation and detect intent signals — moments where the user expresses corrections, emphasis, declarations, rules, or preferences that should be remembered for future interactions.

Signal types to detect:
${enabledDesc}

For each signal found, extract structured knowledge with positive examples (what TO do) and negative examples (what NOT to do).

Return JSON only. Schema:
[{
  "type": "correction|emphasis|declaration|rule|preference",
  "confidence": 0.0-1.0,
  "title": "short descriptive title (<= 50 chars)",
  "content": "the knowledge statement to remember",
  "positives": ["example of correct behavior"],
  "negatives": ["example of incorrect behavior"],
  "sourceFragment": "exact quote from conversation that triggered this signal",
  "tags": ["relevant", "tags"]
}]

Return an empty array [] if no signals are detected.

Conversation:
${transcript}

Title rule: every title must be concise and no longer than 50 characters. If the content is long, summarize the title instead of copying the full content.`;
}
