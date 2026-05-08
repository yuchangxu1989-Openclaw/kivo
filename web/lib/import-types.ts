export interface ImportCandidate {
  id: string;
  type: string;
  title: string;
  content: string;
  sourceAnchor: string;
  sourceContext?: string;
  domain?: string;
  status: 'pending' | 'confirmed' | 'rejected';
}
