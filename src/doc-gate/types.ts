export type ReferenceKind = 'api' | 'config' | 'error-code' | 'code-block';

export interface DocReference {
  kind: ReferenceKind;
  name: string;
  file: string;
  line: number;
}

export interface Mismatch {
  reference: DocReference;
  reason: 'missing-in-code' | 'signature-changed' | 'example-parse-error';
  detail: string;
}

export interface ScanResult {
  references: DocReference[];
  mismatches: Mismatch[];
  scannedFiles: string[];
}

export interface DocGateOptions {
  docsDir: string;
  srcDir: string;
  exportFile?: string;
  strict?: boolean;
}
