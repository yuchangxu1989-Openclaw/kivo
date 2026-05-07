export type AssociationType = 'supplements' | 'depends_on' | 'conflicts' | 'supersedes';

export interface Association {
  sourceId: string;
  targetId: string;
  type: AssociationType;
  strength: number;
  metadata?: Record<string, unknown>;
}

export interface AssociationFilter {
  sourceId?: string;
  targetId?: string;
  type?: AssociationType | AssociationType[];
  minStrength?: number;
}
