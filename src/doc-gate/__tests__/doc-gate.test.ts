import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDocGate } from '../doc-gate-runner.js';
import { scanMarkdownFile } from '../doc-scanner.js';
import { formatReport, hasFailures } from '../reporter.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kivo-doc-gate-'));
}

describe('FR-Z09: Doc-Gate', () => {
  describe('scanMarkdownFile', () => {
    it('extracts API references from markdown', () => {
      const dir = makeTempDir();
      const file = join(dir, 'test.md');
      writeFileSync(file, '# API\n\nCall `runDocGate(` to verify.\n');
      const refs = scanMarkdownFile(file);
      expect(refs.some(r => r.kind === 'api' && r.name === 'runDocGate')).toBe(true);
      rmSync(dir, { recursive: true });
    });

    it('extracts error code references', () => {
      const dir = makeTempDir();
      const file = join(dir, 'test.md');
      writeFileSync(file, 'Handle `ERR_NOT_FOUND` gracefully.\n');
      const refs = scanMarkdownFile(file);
      expect(refs.some(r => r.kind === 'error-code' && r.name === 'ERR_NOT_FOUND')).toBe(true);
      rmSync(dir, { recursive: true });
    });

    it('extracts config key references', () => {
      const dir = makeTempDir();
      const file = join(dir, 'test.md');
      writeFileSync(file, 'Set `kivo.storage.path` in config.\n');
      const refs = scanMarkdownFile(file);
      expect(refs.some(r => r.kind === 'config' && r.name === 'kivo.storage.path')).toBe(true);
      rmSync(dir, { recursive: true });
    });

    it('extracts code blocks for syntax check', () => {
      const dir = makeTempDir();
      const file = join(dir, 'test.md');
      writeFileSync(file, '```ts\nimport { foo } from "kivo";\nfoo();\n```\n');
      const refs = scanMarkdownFile(file);
      expect(refs.some(r => r.kind === 'code-block')).toBe(true);
      rmSync(dir, { recursive: true });
    });
  });

  describe('runDocGate', () => {
    it('passes when docs reference existing exports', () => {
      const dir = makeTempDir();
      const docsDir = join(dir, 'docs');
      const srcDir = join(dir, 'src');
      mkdirSync(docsDir);
      mkdirSync(srcDir);

      writeFileSync(join(docsDir, 'api.md'), '# API\n\nUse `myFunction(` to do things.\n');
      writeFileSync(join(srcDir, 'index.ts'), 'export function myFunction() { return 1; }\n');

      const result = runDocGate({ docsDir, srcDir });
      expect(result.passed).toBe(true);
      expect(result.scanResult.mismatches.length).toBe(0);
      rmSync(dir, { recursive: true });
    });

    it('fails when docs reference missing exports', () => {
      const dir = makeTempDir();
      const docsDir = join(dir, 'docs');
      const srcDir = join(dir, 'src');
      mkdirSync(docsDir);
      mkdirSync(srcDir);

      writeFileSync(join(docsDir, 'api.md'), '# API\n\nUse `nonExistentFunction(` to do things.\n');
      writeFileSync(join(srcDir, 'index.ts'), 'export function otherFunction() { return 1; }\n');

      const result = runDocGate({ docsDir, srcDir });
      expect(result.passed).toBe(false);
      expect(result.scanResult.mismatches.length).toBeGreaterThan(0);
      expect(result.scanResult.mismatches[0].reason).toBe('missing-in-code');
      rmSync(dir, { recursive: true });
    });

    it('passes with empty docs directory', () => {
      const dir = makeTempDir();
      const docsDir = join(dir, 'docs');
      const srcDir = join(dir, 'src');
      mkdirSync(docsDir);
      mkdirSync(srcDir);
      writeFileSync(join(srcDir, 'index.ts'), 'export const x = 1;\n');

      const result = runDocGate({ docsDir, srcDir });
      expect(result.passed).toBe(true);
      rmSync(dir, { recursive: true });
    });
  });

  describe('reporter', () => {
    it('formats clean report', () => {
      const report = formatReport({ references: [], mismatches: [], scannedFiles: [] });
      expect(report).toContain('Mismatches: 0');
      expect(report).toContain('All doc references verified');
    });

    it('formats report with mismatches', () => {
      const report = formatReport({
        references: [{ kind: 'api', name: 'foo', file: 'test.md', line: 1 }],
        mismatches: [{
          reference: { kind: 'api', name: 'foo', file: 'test.md', line: 1 },
          reason: 'missing-in-code',
          detail: 'API "foo" not found',
        }],
        scannedFiles: ['test.md'],
      });
      expect(report).toContain('Mismatches: 1');
      expect(report).toContain('missing-in-code');
    });

    it('hasFailures returns false for empty result', () => {
      expect(hasFailures({ references: [], mismatches: [], scannedFiles: [] })).toBe(false);
    });

    it('hasFailures strict mode catches all mismatches', () => {
      const result = {
        references: [{ kind: 'code-block' as const, name: '(', file: 'x.md', line: 1 }],
        mismatches: [{
          reference: { kind: 'code-block' as const, name: '(', file: 'x.md', line: 1 },
          reason: 'example-parse-error' as const,
          detail: 'Unbalanced brackets',
        }],
        scannedFiles: ['x.md'],
      };
      expect(hasFailures(result, false)).toBe(false); // non-strict ignores parse errors
      expect(hasFailures(result, true)).toBe(true);   // strict catches all
    });
  });
});
