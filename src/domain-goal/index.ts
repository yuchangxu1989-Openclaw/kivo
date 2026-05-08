export type {
  DomainGoal,
  DomainGoalInput,
  DomainGoalChangeType,
  DomainGoalChangeEvent,
  DomainGoalChangeListener,
} from './domain-goal-types.js';
export { DomainGoalStore } from './domain-goal-store.js';
export {
  checkExtractionBoundary,
  boostByDomainGoal,
  detectGaps,
  buildResearchConstraint,
  enforceConstraints,
  type BoundaryCheckResult,
  type RelevanceBoost,
  type GapSuggestion,
  type ResearchConstraint,
  type ConstraintEnforcementResult,
} from './domain-goal-constraints.js';
