export type IntentSignalType =
  | 'correction'
  | 'emphasis'
  | 'declaration'
  | 'rule'
  | 'preference';

export interface IntentSignal {
  type: IntentSignalType;
  confidence: number;
  title: string;
  content: string;
  positives: string[];
  negatives: string[];
  sourceFragment: string;
  tags: string[];
}

export interface SignalDetectorConfig {
  threshold: number;
  enabledTypes: IntentSignalType[];
  maxSignalsPerConversation: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalDetectorConfig = {
  threshold: 0.6,
  enabledTypes: ['correction', 'emphasis', 'declaration', 'rule', 'preference'],
  maxSignalsPerConversation: 5,
};
