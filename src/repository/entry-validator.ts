import { ENTRY_TYPES, type EntryType } from '../types/index.js';

export function validateEntryTypeFields(
  entryType: EntryType,
  metadata: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const fields = metadata.entry_fields as Record<string, unknown> | undefined;

  if (!ENTRY_TYPES.includes(entryType)) {
    errors.push(`Unknown entry_type "${entryType}". Must be one of: ${ENTRY_TYPES.join(', ')}`);
    return errors;
  }

  if (!fields || typeof fields !== 'object') {
    errors.push('metadata.entry_fields is required for typed entries');
    return errors;
  }

  if (typeof fields.title !== 'string' || !fields.title.trim()) {
    errors.push('entry_fields.title is required');
  }
  if (typeof fields.summary !== 'string' || !fields.summary.trim()) {
    errors.push('entry_fields.summary is required');
  }
  if (typeof fields.body !== 'string' || !fields.body.trim()) {
    errors.push('entry_fields.body is required');
  }

  if (fields.difficulty !== undefined) {
    const d = Number(fields.difficulty);
    if (![1, 2, 3, 4, 5].includes(d)) {
      errors.push('entry_fields.difficulty must be 1-5');
    }
  }
  if (fields.importance !== undefined) {
    if (!['high', 'medium', 'low'].includes(String(fields.importance))) {
      errors.push('entry_fields.importance must be high/medium/low');
    }
  }

  if (entryType === 'question') {
    if (typeof fields.answer !== 'string' || !fields.answer.trim()) {
      errors.push('entry_fields.answer is required for question entries');
    }
  }

  if (entryType === 'mistake') {
    ['original_question', 'wrong_answer', 'error_cause', 'correction'].forEach((f) => {
      if (typeof (fields as Record<string, unknown>)[f] !== 'string' || !String((fields as Record<string, unknown>)[f] ?? '').trim()) {
        errors.push(`entry_fields.${f} is required for mistake entries`);
      }
    });
  }

  return errors;
}

export function validateAndWarn(
  entryType: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string[] {
  if (!entryType) return [];
  if (!ENTRY_TYPES.includes(entryType as EntryType)) {
    return [`Unknown entry_type "${entryType}"`];
  }
  return validateEntryTypeFields(entryType as EntryType, metadata ?? {});
}
