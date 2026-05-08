import type { ScanResult, Mismatch } from './types.js';

export function formatReport(result: ScanResult): string {
  const lines: string[] = [
    'Doc-Code Consistency Report',
    '='.repeat(40),
    '',
    `Scanned files: ${result.scannedFiles.length}`,
    `References found: ${result.references.length}`,
    `Mismatches: ${result.mismatches.length}`,
    '',
  ];

  if (result.mismatches.length === 0) {
    lines.push('All doc references verified against code.');
    return lines.join('\n');
  }

  lines.push('Mismatches:');
  lines.push('-'.repeat(40));

  for (const m of result.mismatches) {
    lines.push(`  [${m.reason}] ${m.reference.file}:${m.reference.line}`);
    lines.push(`    ${m.reference.kind}: ${m.reference.name}`);
    lines.push(`    ${m.detail}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function hasFailures(result: ScanResult, strict?: boolean): boolean {
  if (strict) return result.mismatches.length > 0;
  return result.mismatches.some(
    m => m.reason === 'missing-in-code' || m.reason === 'signature-changed',
  );
}
