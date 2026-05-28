export const RELATION_TYPES = [
  'prerequisite_of',
  'explains',
  'illustrates',
  'assesses',
  'solved_by',
  'confusable_with',
  'derived_from',
  'proves',
  'applies_to',
  'belongs_to',
  'has_part',
  'annotated_with',
] as const;

export type RelationType = typeof RELATION_TYPES[number];

const RELATION_TYPE_SET = new Set<string>(RELATION_TYPES);

export function isRelationType(value: unknown): value is RelationType {
  return typeof value === 'string' && RELATION_TYPE_SET.has(value);
}
