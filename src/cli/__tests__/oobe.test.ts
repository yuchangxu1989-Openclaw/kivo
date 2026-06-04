import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAutomationCommands } from '../automation-setup.js';
import { runInit } from '../init.js';
import { runAdd } from '../add.js';

vi.mock('../../pipeline/value-gate.js', () => ({
  assessIngestValue: vi.fn(async () => ({
    isHighValue: false,
    category: 'common_knowledge',
    confidence: 0,
    reasoning: 'test should be bypassed',
    dimensions: {
      privacy: 0,
      scenarioSpecificity: 0,
      llmBlindSpot: 0,
      timeliness: 0,
      crossScenario: 0,
      abstractness: 0,
    },
  })),
}));

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let tempDirs: string[] = [];

const HOST_PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'KIVO_LLM_MODEL',
  'KIVO_LLM_API_KEY',
  'KIVO_EMBEDDING_API_KEY',
  'OPENCLAW_CONFIG',
  'OPENCLAW_HOME',
  'OPENCLAW_WORKSPACE',
  'KIVO_DB_PATH',
] as const;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kivo-oobe-'));
  tempDirs.push(dir);
  return dir;
}

function makeIsolatedEnv(dir: string): NodeJS.ProcessEnv {
  const env = { ...originalEnv };
  for (const key of HOST_PROVIDER_ENV_KEYS) {
    delete env[key];
  }
  env.HOME = dir;
  env.USERPROFILE = dir;
  env.OPENCLAW_CONFIG = join(dir, 'no-openclaw', 'openclaw.json');
  env.OPENCLAW_HOME = join(dir, 'no-openclaw-home');
  env.OPENCLAW_WORKSPACE = join(dir, 'no-openclaw-workspace');
  return env;
}

function useIsolatedHostEnv(dir: string): NodeJS.ProcessEnv {
  const env = makeIsolatedEnv(dir);
  process.env = env;
  return env;
}

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('CLI out-of-box errors', () => {
  it('reports missing LLM provider guidance for add when quality gate is enabled', async () => {
    const dir = makeTempDir();
    useIsolatedHostEnv(dir);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENCLAW_CONFIG).toBe(join(dir, 'no-openclaw', 'openclaw.json'));
    process.chdir(dir);
    await runInit({ nonInteractive: true, dir });

    await expect(runAdd('fact', 'provider needed', { content: 'content' })).rejects.toThrow(/需要配置 LLM provider[\s\S]*README Prerequisites/);
  });

  it('lets --no-quality-gate bypass ValueGate rejection and write an entry', async () => {
    const dir = makeTempDir();
    useIsolatedHostEnv(dir);
    process.chdir(dir);
    await runInit({ nonInteractive: true, dir });

    const output = await runAdd('fact', 'manual migration note', {
      content: 'A migration note that is intentionally admitted without model-based quality gates.',
      noQualityGate: true,
    });

    expect(output).toContain('✓ Added [fact]');
    expect(output).toContain('配置 embedding provider');
  });
});

describe('init automation output', () => {
  it('uses the caller directory in automation commands instead of a development path', () => {
    const dir = makeTempDir();
    useIsolatedHostEnv(dir);
    const commands = buildAutomationCommands(dir);

    expect(commands.cronLines.join('\n')).toContain(`cd '${dir}'`);
    expect(commands.cronLines.join('\n')).not.toContain('/root/.openclaw/workspace/projects/kivo');
  });
});

describe('CLI flag wiring', () => {
  it('passes --no-quality-gate through the add command parser', async () => {
    const dir = makeTempDir();
    const env = useIsolatedHostEnv(dir);
    process.chdir(dir);
    await runInit({ nonInteractive: true, dir });

    const cli = join(originalCwd, 'dist/esm/cli/index.js');
    const { execFileSync } = await import('node:child_process');
    const output = execFileSync('node', [cli, 'add', 'fact', 'CLI bypass', '--content', 'This write goes through the real CLI flag parser and should bypass model gates.', '--no-quality-gate'], {
      cwd: dir,
      env,
      encoding: 'utf-8',
    });

    expect(output).toContain('✓ Added [fact]');
  });
});
