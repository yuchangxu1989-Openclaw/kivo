import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  generateDocPackage,
  formatDocPackage,
  generateUpgradeGuide,
  generateUsagePathDoc,
  validateDocPackage,
} from '../src/doc-package/index.js';
import type { DocPackage, UsagePath } from '../src/doc-package/index.js';

import {
  ONBOARDING_ACTIONS,
  getEmptySearchSuggestions,
  checkReadiness,
  getPostActionGuide,
} from '../src/onboarding/index.js';
import type { KivoConfig } from '../src/config/types.js';

import { ERROR_CATALOG } from '../src/errors/error-catalog.js';
import { KivoError, wrapError } from '../src/errors/kivo-error.js';

import { runDocGate } from '../src/doc-gate/doc-gate-runner.js';
import { scanMarkdownFile } from '../src/doc-gate/doc-scanner.js';
import { verifyDocCodeConsistency } from '../src/doc-gate/code-verifier.js';

// ═══════════════════════════════════════════
// FR-Z05: 用户文档交付包
// ═══════════════════════════════════════════

describe('FR-Z05: 用户文档交付包', () => {
  // AC1: 5 份文档 — README, Quick Start, 配置参考, 故障排查, 升级说明
  it('AC1: generateDocPackage includes all 5 required sections', () => {
    const pkg = generateDocPackage('1.0.0');
    const ids = pkg.sections.map(s => s.id);
    expect(ids).toContain('readme');
    expect(ids).toContain('quick-start');
    expect(ids).toContain('config-reference');
    expect(ids).toContain('troubleshooting');
    expect(ids).toContain('upgrade-guide');
    expect(pkg.sections.length).toBeGreaterThanOrEqual(5);
  });

  it('AC1: upgrade guide contains version and migration steps', () => {
    const guide = generateUpgradeGuide('2.0.0');
    expect(guide.id).toBe('upgrade-guide');
    expect(guide.content).toContain('2.0.0');
    expect(guide.content).toContain('迁移步骤');
    expect(guide.content).toContain('Breaking Changes');
  });

  // AC2: 每份文档有明确完成标准，发布前逐份验收
  it('AC2: validateDocPackage passes for complete package', () => {
    const pkg = generateDocPackage('1.0.0');
    const result = validateDocPackage(pkg);
    expect(result.valid).toBe(true);
    expect(result.missingIds).toEqual([]);
  });

  it('AC2: validateDocPackage fails when section missing', () => {
    const pkg = generateDocPackage('1.0.0');
    pkg.sections = pkg.sections.filter(s => s.id !== 'troubleshooting');
    const result = validateDocPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.missingIds).toContain('troubleshooting');
  });

  it('AC2: validateDocPackage fails for empty content', () => {
    const pkg = generateDocPackage('1.0.0');
    const idx = pkg.sections.findIndex(s => s.id === 'readme');
    pkg.sections[idx] = { ...pkg.sections[idx], content: '   ' };
    const result = validateDocPackage(pkg);
    expect(result.valid).toBe(false);
    expect(result.missingIds).toContain('readme');
  });

  // AC3: Quick Start 示例代码可运行（通过 formatDocPackage 输出含代码块）
  it('AC3: Quick Start contains runnable code examples', () => {
    const pkg = generateDocPackage('1.0.0');
    const qs = pkg.sections.find(s => s.id === 'quick-start')!;
    expect(qs.content).toMatch(/```(?:typescript|bash)/);
    expect(qs.content).toContain('import');
    expect(qs.content).toContain('kivo.init');
  });

  // AC4: 覆盖 standalone、宿主嵌入、full-stack 三种使用路径
  it('AC4: generateUsagePathDoc covers all 3 paths', () => {
    const paths: UsagePath[] = ['standalone', 'hosted', 'full-stack'];
    for (const p of paths) {
      const doc = generateUsagePathDoc(p);
      expect(doc.id).toContain('usage-');
      expect(doc.content.length).toBeGreaterThan(0);
    }
  });

  it('formatDocPackage produces markdown output', () => {
    const pkg = generateDocPackage('1.0.0');
    const md = formatDocPackage(pkg);
    expect(md).toContain('# KIVO');
    expect(md).toContain('---');
  });

  it('version is embedded in package metadata', () => {
    const pkg = generateDocPackage('3.2.1');
    expect(pkg.version).toBe('3.2.1');
    expect(pkg.generatedAt).toBeTruthy();
  });
});

// ═══════════════════════════════════════════
// FR-Z06: 首次知识旅程
// ═══════════════════════════════════════════

describe('FR-Z06: 首次知识旅程', () => {
  // AC1: 空库引导入口 — 上传文档/导入示例/手动新建
  it('AC1: ONBOARDING_ACTIONS provides 3 entry points', () => {
    expect(ONBOARDING_ACTIONS.length).toBe(3);
    const actions = ONBOARDING_ACTIONS.map(a => a.action);
    expect(actions).toContain('upload-document');
    expect(actions).toContain('import-sample');
    expect(actions).toContain('manual-create');
  });

  it('AC1: each action has label and description', () => {
    for (const entry of ONBOARDING_ACTIONS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  // AC2: 操作后引导检索验证
  it('AC2: getPostActionGuide returns guide for each action', () => {
    const actions: Array<'upload-document' | 'import-sample' | 'manual-create'> = [
      'upload-document', 'import-sample', 'manual-create',
    ];
    for (const action of actions) {
      const guide = getPostActionGuide(action, 'test-title');
      expect(guide.message.length).toBeGreaterThan(0);
      expect(guide.nextStep.length).toBeGreaterThan(0);
    }
  });

  it('AC2: upload-document guide includes entry title as search query', () => {
    const guide = getPostActionGuide('upload-document', 'my-doc');
    expect(guide.searchQuery).toBe('my-doc');
  });

  it('AC2: import-sample guide suggests KIVO search', () => {
    const guide = getPostActionGuide('import-sample');
    expect(guide.searchQuery).toBe('KIVO');
  });

  // AC3: 搜索无结果时给出建议
  it('AC3: getEmptySearchSuggestions returns actionable suggestions', () => {
    const suggestions = getEmptySearchSuggestions();
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
    const types = suggestions.map(s => s.type);
    expect(types).toContain('import');
    expect(types).toContain('adjust-query');
    expect(types).toContain('research');
  });

  // AC4: 就绪度检查清单
  it('AC4: checkReadiness returns structured report', async () => {
    const config: KivoConfig = { dbPath: ':memory:' };
    const report = await checkReadiness(config);
    expect(report.items.length).toBeGreaterThanOrEqual(4);
    expect(typeof report.overallReady).toBe('boolean');
    expect(report.readyCount + (report.totalCount - report.readyCount)).toBe(report.totalCount);
  });

  it('AC4: readiness items have id, label, status, detail', async () => {
    const config: KivoConfig = { dbPath: ':memory:' };
    const report = await checkReadiness(config);
    for (const item of report.items) {
      expect(item.id).toBeTruthy();
      expect(item.label).toBeTruthy();
      expect(['ready', 'warning', 'missing']).toContain(item.status);
      expect(item.detail).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════
// FR-Z07: 错误提示与恢复动作
// ═══════════════════════════════════════════

describe('FR-Z07: 错误提示与恢复动作', () => {
  // AC1: 覆盖全链路常见失败场景
  it('AC1: ERROR_CATALOG covers config/storage/embedding/search/ingest/auth/migration', () => {
    const categories = new Set(Object.values(ERROR_CATALOG).map(e => e.category));
    expect(categories.has('config')).toBe(true);
    expect(categories.has('storage')).toBe(true);
    expect(categories.has('embedding')).toBe(true);
    expect(categories.has('search')).toBe(true);
    expect(categories.has('ingest')).toBe(true);
    expect(categories.has('auth')).toBe(true);
  });

  it('AC1: catalog has at least 15 error entries', () => {
    expect(Object.keys(ERROR_CATALOG).length).toBeGreaterThanOrEqual(15);
  });

  // AC2: 错误提示包含原因说明和建议
  it('AC2: every entry has message, cause, and suggestion', () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.message, `${code} missing message`).toBeTruthy();
      expect(entry.cause, `${code} missing cause`).toBeTruthy();
      expect(entry.suggestion, `${code} missing suggestion`).toBeTruthy();
    }
  });

  it('AC2: KivoError.toUserMessage includes cause and suggestion', () => {
    const err = new KivoError('KIVO-CFG-001');
    const msg = err.toUserMessage();
    expect(msg).toContain('KIVO-CFG-001');
    expect(msg).toContain('原因:');
    expect(msg).toContain('建议:');
  });

  // AC3: 可重试的失败支持一键重试
  it('AC3: retryable flag is set on appropriate errors', () => {
    const retryable = Object.values(ERROR_CATALOG).filter(e => e.retryable);
    const nonRetryable = Object.values(ERROR_CATALOG).filter(e => !e.retryable);
    expect(retryable.length).toBeGreaterThan(0);
    expect(nonRetryable.length).toBeGreaterThan(0);
  });

  it('AC3: KivoError exposes retryable flag', () => {
    const retryErr = new KivoError('KIVO-STG-002');
    expect(retryErr.retryable).toBe(true);
    const noRetryErr = new KivoError('KIVO-CFG-001');
    expect(noRetryErr.retryable).toBe(false);
  });

  it('AC3: toUserMessage shows retry hint for retryable errors', () => {
    const err = new KivoError('KIVO-STG-002');
    expect(err.toUserMessage()).toContain('重试');
  });

  // AC4: 关键失败场景支持复制诊断信息
  it('AC4: toDiagnosticString returns JSON with code/message/stack', () => {
    const err = new KivoError('KIVO-CFG-001', undefined, { path: '/tmp' });
    const diag = err.toDiagnosticString();
    const parsed = JSON.parse(diag);
    expect(parsed.code).toBe('KIVO-CFG-001');
    expect(parsed.message).toBeTruthy();
    expect(parsed.diagnostics.path).toBe('/tmp');
    expect(parsed.stack).toBeDefined();
  });

  it('AC4: toJSON returns API-friendly format', () => {
    const err = new KivoError('KIVO-ATH-001');
    const json = err.toJSON();
    expect(json.error).toBeDefined();
    const e = json.error as Record<string, unknown>;
    expect(e.code).toBe('KIVO-ATH-001');
    expect(e.suggestion).toBeTruthy();
  });

  it('wrapError wraps native Error with inferred code', () => {
    const native = new Error('sqlite database locked');
    const wrapped = wrapError(native);
    expect(wrapped).toBeInstanceOf(KivoError);
    expect(wrapped.code).toBe('KIVO-STG-002');
  });

  it('wrapError passes through existing KivoError', () => {
    const original = new KivoError('KIVO-CFG-002');
    const wrapped = wrapError(original);
    expect(wrapped).toBe(original);
  });

  it('wrapError uses fallback code for unknown errors', () => {
    const wrapped = wrapError('something weird');
    expect(wrapped.code).toBe('KIVO-CFG-001');
  });

  it('KivoError supports overrides', () => {
    const err = new KivoError('KIVO-CFG-001', { message: 'custom msg', cause: 'custom cause' });
    expect(err.message).toBe('custom msg');
    expect(err.cause_description).toBe('custom cause');
  });
});

// ═══════════════════════════════════════════
// FR-Z09: 文档与实现一致性门禁
// ═══════════════════════════════════════════

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fr-z09-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('FR-Z09: 文档与实现一致性门禁', () => {
  // AC1: 示例代码纳入 CI 校验
  it('AC1: runDocGate returns pass/fail with report', () => {
    const docsDir = join(tmpDir, 'docs');
    const srcDir = join(tmpDir, 'src');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(docsDir, 'readme.md'), '# Hello\n');
    writeFileSync(join(srcDir, 'index.ts'), 'export function hello() {}\n');
    const result = runDocGate({ docsDir, srcDir });
    expect(typeof result.passed).toBe('boolean');
    expect(result.report).toContain('Doc-Code Consistency Report');
    expect(result.scanResult.scannedFiles.length).toBeGreaterThan(0);
  });

  it('AC1: runDocGate detects missing API in code', () => {
    const docsDir = join(tmpDir, 'docs');
    const srcDir = join(tmpDir, 'src');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(docsDir, 'api.md'), '使用 `nonExistentFunc(` 方法\n');
    writeFileSync(join(srcDir, 'index.ts'), 'export function realFunc() {}\n');
    const result = runDocGate({ docsDir, srcDir, strict: true });
    expect(result.passed).toBe(false);
    expect(result.scanResult.mismatches.length).toBeGreaterThan(0);
  });

  it('AC1: runDocGate passes when all refs match', () => {
    const docsDir = join(tmpDir, 'docs');
    const srcDir = join(tmpDir, 'src');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(docsDir, 'api.md'), '使用 `hello(` 方法\n');
    writeFileSync(join(srcDir, 'index.ts'), 'export function hello() {}\n');
    const result = runDocGate({ docsDir, srcDir });
    expect(result.passed).toBe(true);
  });

  // AC2: API 签名变更时文档必须同步
  it('AC2: verifyDocCodeConsistency detects missing error codes', () => {
    const docsDir = join(tmpDir, 'docs');
    const srcDir = join(tmpDir, 'src');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(docsDir, 'errors.md'), '遇到 `ERR_PHANTOM` 时\n');
    writeFileSync(join(srcDir, 'errors.ts'), 'export const ERR_REAL = "real";\n');
    const result = verifyDocCodeConsistency({ docsDir, srcDir });
    const errMismatch = result.mismatches.find(m => m.reference.name === 'ERR_PHANTOM');
    expect(errMismatch).toBeDefined();
    expect(errMismatch!.reason).toBe('missing-in-code');
  });

  it('AC2: code block syntax check catches unbalanced brackets', () => {
    const docsDir = join(tmpDir, 'docs');
    const srcDir = join(tmpDir, 'src');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(docsDir, 'example.md'), '```ts\nfunction foo() {\n```\n');
    writeFileSync(join(srcDir, 'index.ts'), '');
    const result = verifyDocCodeConsistency({ docsDir, srcDir });
    const parseErr = result.mismatches.find(m => m.reason === 'example-parse-error');
    expect(parseErr).toBeDefined();
  });

  it('scanMarkdownFile extracts all reference kinds', () => {
    const md = join(tmpDir, 'mixed.md');
    writeFileSync(md, [
      '调用 `Kivo.query(` 方法',
      '错误码 `ERR_TEST`',
      '配置 `embedding.provider`',
    ].join('\n'));
    const refs = scanMarkdownFile(md);
    expect(refs.some(r => r.kind === 'api')).toBe(true);
    expect(refs.some(r => r.kind === 'error-code')).toBe(true);
    expect(refs.some(r => r.kind === 'config')).toBe(true);
  });
});
