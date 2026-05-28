export interface SourceRange {
  documentId?: string;
  kind: 'paragraph' | 'line' | 'page' | 'chapter' | 'item' | 'full';
  start: number;
  end: number;
  page?: number;
  paragraph?: number | { start: number; end: number };
  section?: string;
  originalText?: string;
}

export interface SourceContextParagraph {
  index: number;
  text: string;
  highlighted?: boolean;
}

export interface ImportCandidate {
  id: string;
  type: string;
  title: string;
  content: string;
  sourceAnchor: string;
  sourceContext?: string;
  sourceDocument?: string;
  sourceLocation?: string;
  sourceRange?: SourceRange;
  sourceParagraphs?: SourceContextParagraph[];
  domain?: string;
  status: 'pending' | 'confirmed' | 'rejected';
}
