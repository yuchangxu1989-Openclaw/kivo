import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanMarkdownFile, scanDocsDir } from '../src/doc-gate/doc-scanner.js';
import { verifyDocCodeConsistency } from '../src/doc-gate/code-verifier.js';
import { formatReport, hasFailures } from '../src/doc-gate/reporter.js';
import type { ScanResult, DocGateOptions } from '../src/doc-gate/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'doc-gate-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Scanner ──

describe('scanMarkdownFile', () => {
  it('extracts API references from backtick calls', () => {
    const md = join(tmpDir, 'api.md');
    writeFileSync(md, '使用 `Kivo.ingest(` 方法导入知识\n');
    const refs = scanMarkdownFile(md);
    expect(refs.some(r => r.kind === 'api' && r.name === 'Kivo.ingest')).toBe(true);
  });

  it('extracts error code references', () => {
    const md = join(tmpDir, 'errors.md');
    writeFileSync(md, '遇到 `ERR_STORAGE_FULL` 时请清理\n');
    const refs = scanMarkdownFile(md);
    expect(refs.some(r => r.kind === 'error-code' && r.name === 'ERR_STORAGE_FULL')).toBe(true);
  });

  it('extracts config key references', () => {
    const md = join(tmpDir, 'config.md');
    writeFileSync(md, '设置 `embedding.provider` 为 openai\n');
    const refs = scanMarkdownFile(md);
    expect(refs.some(r => r.kind === 'config' && r.name === 'embedding.provider')).toBe(true);
  });

  it('extracts code blocks', () => {
    const md = join(tmpDir, 'example.md');
    writeFileSync(md, '```ts\nconst k = new Kivo();\n```\n');
    const refs = scanMarkdownFile(md);
    expect(refs.some(r => r.kind === 'code-block')).toBe(true);
  });
  it('records correct line numbers', () => {
    const md = join(tmpDir, 'lines.md');
    writeFileSync(md, 'line1\n`myFunc(` on line 2\nline3\n');
    const refs = scanMarkdownFile(md);
    const apiRef = refs.find(r => r.kind === 'api');
    expect(apiRef?.line).toBe(2);
  });

  it('returns empty for file with no references', () => {
    const md = join(tmpDir, 'empty.md');
    writeFileSync(md, '# Just a heading\n\nSome plain text.\n');
    expect(scanMarkdownFile(md)).toHaveLength(0);
  });

  it('does not double-count error codes as config keys', () => {
    const md = join(tmpDir, 'nodup.md');
    writeFileSync(md, '`ERR_NOT_FOUND` should not be config\n');
    const refs = scanMarkdownFile(md);
    expect(refs.filter(r => r.kind === 'config')).toHaveLength(0);
  });
});

describe('scanDocsDir', () => {
  it('scans all markdown files recursively', () => {
    const sub = join(tmpDir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(tmpDir, 'a.md'), '`funcA(`\n');
    writeFileSync(join(sub, 'b.md'), '`funcB(`\n');
    const { refs, files } = scanDocsDir(tmpDir);
    expect(files.length).toBe(2);
    expect(refs.some(r => r.name === 'funcA')).toBe(true);
    expect(refs.some(r => r.name === 'funcB')).toBe(true);
  });

  it('returns empty for non-existent directory', () => {
    const { refs, files } = scanDocsDir(join(tmpDir, 'nope'));
    expect(files).toHaveLength(0);
    expect(refs).toHaveLength(0);
  });
});

// ── Verifier ──

describe('verifyDocCodeConsistency', () => {
  function setupFixture(docContent: string, srcContent: string): DocGateOptions {
    const docsDir = join(tmpDir, 'docs');
    const srcDir = join(tmpDir, 'src');
    mkdirSync(docsDir);
    mkdirSync(srcDir);
    writeFileSync(join(docsDir, 'readme.md'), docContent);
    writeFileSync(join(srcDir, 'index.ts'), srcContent);
    return { docsDir, srcDir, exportFile: join(srcDir, 'index.ts') };
  }

  it('reports no mismatches when doc refs match exports', () => {
    const opts = setupFixture(
      '使用 `Kivo(` 创建实例\n',
      'export class Kivo {}\n',
    );
    const result = verifyDocCodeConsistency(opts);
    expect(result.mismatches).toHaveLength(0);
  });

  it('reports missing API', () => {
    const opts = setupFixture(
      '调用 `NonExistent(` 方法\n',
      'export class Kivo {}\n',
    );
    const result = verifyDocCodeConsistency(opts);
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.mismatches[0].reason).toBe('missing-in-code');
  });

  it('reports missing error code', () => {
    const opts = setupFixture(
      '遇到 `ERR_PHANTOM` 时\n',
      'export const ERR_STORAGE = "storage";\n',
    );
    const result = verifyDocCodeConsistency(opts);
    expect(result.mismatches.some(m => m.reference.name === 'ERR_PHANTOM')).toBe(true);
  });

  it('detects code block syntax issues', () => {
    const opts = setupFixture(
      '```ts\nconst x = {\n```\n',
      'export class Kivo {}\n',
    );
    const result = verifyDocCodeConsistency(opts);
    expect(result.mismatches.some(m => m.reason === 'example-parse-error')).toBe(true);
  });

  it('passes valid code blocks', () => {
    const opts = setupFixture(
      '```ts\nconst x = { a: 1 };\n```\n',
      'export class Kivo {}\n',
    );
    const result = verifyDocCodeConsistency(opts);
    expect(result.mismatches.filter(m => m.reason === 'example-parse-error')).toHaveLength(0);
  });

  it('finds config keys in source files', () => {
    const opts = setupFixture(
      '设置 `embedding.provider` 为 openai\n',
      'export const config = { provider: "openai" };\n',
    );
    const result = verifyDocCodeConsistency(opts);
    expect(result.mismatches.filter(m => m.reference.kind === 'config')).toHaveLength(0);
  });
});

// ── Reporter ──

describe('formatReport', () => {
  it('shows clean report when no mismatches', () => {
    const result: ScanResult = { references: [], mismatches: [], scannedFiles: ['a.md'] };
    const report = formatReport(result);
    expect(report).toContain('Mismatches: 0');
    expect(report).toContain('All doc references verified');
  });

  it('lists mismatches with file and line', () => {
    const result: ScanResult = {
      references: [],
      mismatches: [{
        reference: { kind: 'api', name: 'foo', file: 'docs/api.md', line: 10 },
        reason: 'missing-in-code',
        detail: 'API "foo" not found',
      }],
      scannedFiles: ['docs/api.md'],
    };
    const report = formatReport(result);
    expect(report).toContain('docs/api.md:10');
    expect(report).toContain('missing-in-code');
  });
});

describe('hasFailures', () => {
  it('returns false for empty mismatches', () => {
    const result: ScanResult = { references: [], mismatches: [], scannedFiles: [] };
    expect(hasFailures(result)).toBe(false);
  });

  it('returns true for missing-in-code', () => {
    const result: ScanResult = {
      references: [],
      mismatches: [{
        reference: { kind: 'api', name: 'x', file: 'a.md', line: 1 },
        reason: 'missing-in-code',
        detail: '',
      }],
      scannedFiles: [],
    };
    expect(hasFailures(result)).toBe(true);
  });

  it('strict mode fails on parse errors too', () => {
    const result: ScanResult = {
      references: [],
      mismatches: [{
        reference: { kind: 'code-block', name: 'x', file: 'a.md', line: 1 },
        reason: 'example-parse-error',
        detail: '',
      }],
      scannedFiles: [],
    };
    expect(hasFailures(result, false)).toBe(false);
    expect(hasFailures(result, true)).toBe(true);
  });
});
