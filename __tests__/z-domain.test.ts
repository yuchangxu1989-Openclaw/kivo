import { describe, expect, it } from 'vitest';
import {
  checkEnvironment,
  formatEnvCheckReport,
  SUPPORT_MATRIX,
} from '../src/cli/install-validator.js';
import {
  resolveSecrets,
  checkSecrets,
  maskSecret,
  formatSecretReport,
} from '../src/config/secret-manager.js';
import { generateDocPackage, formatDocPackage } from '../src/doc-package/index.js';

// ── FR-Z01: Install Validator ──

describe('checkEnvironment (FR-Z01)', () => {
  it('checks Node.js version', () => {
    const report = checkEnvironment();
    const nodeItem = report.items.find(i => i.name === 'Node.js 版本');
    expect(nodeItem).toBeTruthy();
    // Current Node should pass
    expect(nodeItem!.status).toBe('pass');
  });

  it('checks OS', () => {
    const report = checkEnvironment();
    const osItem = report.items.find(i => i.name === '操作系统');
    expect(osItem).toBeTruthy();
  });

  it('checks architecture', () => {
    const report = checkEnvironment();
    const archItem = report.items.find(i => i.name === '系统架构');
    expect(archItem).toBeTruthy();
  });

  it('reports allPassed correctly', () => {
    const report = checkEnvironment(':memory:');
    // Should pass on a valid Node.js environment
    expect(typeof report.allPassed).toBe('boolean');
    expect(report.passCount + report.failCount + report.warnCount).toBe(report.items.length);
  });

  it('formatEnvCheckReport produces readable output', () => {
    const report = checkEnvironment();
    const formatted = formatEnvCheckReport(report);
    expect(formatted).toContain('KIVO 环境校验报告');
    expect(formatted).toContain('Node.js');
  });

  it('SUPPORT_MATRIX is defined', () => {
    expect(SUPPORT_MATRIX.nodeVersions.length).toBeGreaterThan(0);
    expect(SUPPORT_MATRIX.os.length).toBeGreaterThan(0);
  });
});

// ── FR-Z04: Secret Manager ──

describe('SecretManager (FR-Z04)', () => {
  it('resolves ${ENV_VAR} placeholders (AC1/AC2)', () => {
    process.env.TEST_KIVO_KEY = 'my-secret-key';
    const config = resolveSecrets({
      apiKey: '${TEST_KIVO_KEY}',
      nested: { key: '${TEST_KIVO_KEY}' },
      array: ['${TEST_KIVO_KEY}', 'plain'],
    });
    expect(config.apiKey).toBe('my-secret-key');
    expect((config.nested as Record<string, string>).key).toBe('my-secret-key');
    expect((config.array as string[])[0]).toBe('my-secret-key');
    expect((config.array as string[])[1]).toBe('plain');
    delete process.env.TEST_KIVO_KEY;
  });

  it('resolves to empty string for missing env var', () => {
    delete process.env.NONEXISTENT_VAR;
    const config = resolveSecrets({ key: '${NONEXISTENT_VAR}' });
    expect(config.key).toBe('');
  });

  it('maskSecret hides middle of value (AC4)', () => {
    expect(maskSecret('sk-1234567890abcdef')).toBe('sk-1...cdef');
    expect(maskSecret('short')).toBe('****');
  });

  it('checkSecrets reports configured/missing (AC3)', () => {
    process.env.KIVO_TEST_SECRET = 'value';
    const report = checkSecrets([
      { key: 'test.secret', envVar: 'KIVO_TEST_SECRET', required: true },
      { key: 'test.missing', envVar: 'KIVO_MISSING_SECRET_XYZ', required: true },
    ]);
    expect(report.allRequired).toBe(false);
    expect(report.missingRequired).toContain('KIVO_MISSING_SECRET_XYZ');
    delete process.env.KIVO_TEST_SECRET;
  });

  it('formatSecretReport produces readable output', () => {
    const report = checkSecrets();
    const formatted = formatSecretReport(report);
    expect(formatted).toContain('密钥配置状态');
  });
});

// ── FR-Z05: Doc Package ──

describe('DocPackage (FR-Z05)', () => {
  it('generates all required sections (AC1)', () => {
    const pkg = generateDocPackage('0.3.1');
    expect(pkg.sections).toHaveLength(5);
    expect(pkg.sections.map(s => s.id)).toEqual([
      'readme', 'quick-start', 'config-reference', 'troubleshooting', 'upgrade-guide',
    ]);
  });

  it('includes version in readme (AC2)', () => {
    const pkg = generateDocPackage('1.0.0');
    const readme = pkg.sections.find(s => s.id === 'readme');
    expect(readme?.content).toContain('1.0.0');
  });

  it('quick start is concise (AC3)', () => {
    const pkg = generateDocPackage('0.3.1');
    const qs = pkg.sections.find(s => s.id === 'quick-start');
    expect(qs?.content).toContain('5 分钟');
  });

  it('formatDocPackage produces markdown', () => {
    const pkg = generateDocPackage('0.3.1');
    const md = formatDocPackage(pkg);
    expect(md).toContain('KIVO');
    expect(md).toContain('故障排查');
  });
});
