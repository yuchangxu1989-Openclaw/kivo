import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CRON_BLOCK_BEGIN = '# >>> KIVO automation >>>';
const CRON_BLOCK_END = '# <<< KIVO automation <<<' ;
const OPENCLAW_CONFIG_PATH = '/root/.openclaw/openclaw.json';
const OPENCLAW_KIVO_PROJECT_DIR = '/root/.openclaw/workspace/projects/kivo';
const DEFAULT_GOVERNANCE_SCHEDULE = '0 4 * * *';
const OPENCLAW_GOVERNANCE_COMMAND = `cd ${OPENCLAW_KIVO_PROJECT_DIR} && npx kivo governance run --auto 2>&1 >> /tmp/kivo-governance.log`;
const OPENCLAW_GOVERNANCE_CRON = `${DEFAULT_GOVERNANCE_SCHEDULE} ${OPENCLAW_GOVERNANCE_COMMAND}`;
const STANDALONE_GOVERNANCE_CRON = `${DEFAULT_GOVERNANCE_SCHEDULE} npx kivo governance run --auto`;
const DEFAULT_WATCH_INTERVAL_MS = 15_000;

export interface AutomationCommands {
  governanceCommand: string;
  watcherCommand: string;
  cronLines: string[];
  watchDir: string;
  stateFile: string;
  standaloneGovernanceCron: string;
}

export interface CrontabInstallResult {
  attempted: boolean;
  installed: boolean;
  message: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function isOpenClawHost(): boolean {
  return existsSync(OPENCLAW_CONFIG_PATH);
}

export function getDefaultBadcaseWatchDir(cwd: string = process.cwd()): string {
  const openclawHome = process.env.OPENCLAW_HOME;
  if (openclawHome) {
    return resolve(openclawHome, 'workspace', 'logs');
  }
  if (isOpenClawHost()) {
    return '/root/.openclaw/workspace/logs';
  }
  return resolve(cwd, 'logs');
}

export function getDefaultWatcherStateFile(cwd: string = process.cwd()): string {
  return resolve(cwd, '.kivo', 'badcase-watcher-state.json');
}

export function buildAutomationCommands(cwd: string = process.cwd()): AutomationCommands {
  const dir = resolve(cwd);
  const logDir = resolve(dir, '.kivo');
  const watchDir = getDefaultBadcaseWatchDir(dir);
  const stateFile = getDefaultWatcherStateFile(dir);
  const watcherLog = resolve(logDir, 'watch-badcases.log');

  const governanceCommand = 'kivo governance run --auto';
  const watcherCommand = `kivo watch-badcases --dir ${shellQuote(watchDir)}`;
  const governanceCron = isOpenClawHost()
    ? OPENCLAW_GOVERNANCE_CRON
    : `${DEFAULT_GOVERNANCE_SCHEDULE} cd ${shellQuote(dir)} && npx kivo governance run --auto >> ${shellQuote(resolve(logDir, 'governance.log'))} 2>&1`;

  const cronLines = [
    governanceCron,
    `@reboot sh -lc ${shellQuote(`cd ${shellQuote(dir)} && mkdir -p ${shellQuote(logDir)} && nohup npx kivo watch-badcases --dir ${shellQuote(watchDir)} --state-file ${shellQuote(stateFile)} --interval ${DEFAULT_WATCH_INTERVAL_MS} >> ${shellQuote(watcherLog)} 2>&1 &`)}`,
  ];

  return {
    governanceCommand,
    watcherCommand,
    cronLines,
    watchDir,
    stateFile,
    standaloneGovernanceCron: STANDALONE_GOVERNANCE_CRON,
  };
}

export function installAutomationCrontab(cwd: string = process.cwd()): CrontabInstallResult {
  if (!isOpenClawHost()) {
    return {
      attempted: false,
      installed: false,
      message: `未检测到 OpenClaw 宿主环境。请手动添加 cron: ${STANDALONE_GOVERNANCE_CRON}`,
    };
  }

  const dir = resolve(cwd);
  const logDir = resolve(dir, '.kivo');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const commands = buildAutomationCommands(dir);
  const cronBlock = [CRON_BLOCK_BEGIN, ...commands.cronLines, CRON_BLOCK_END].join('\n');

  const current = spawnSync('crontab', ['-l'], { encoding: 'utf-8' });
  if (current.error) {
    return {
      attempted: true,
      installed: false,
      message: `crontab 不可用，跳过自动注册：${current.error.message}`,
    };
  }

  const existing = current.status === 0 ? current.stdout.trim() : '';
  if (existing.includes(OPENCLAW_GOVERNANCE_COMMAND)) {
    return {
      attempted: true,
      installed: false,
      message: '已存在 KIVO governance cron，跳过重复注册。',
    };
  }

  const cleaned = existing
    .replace(new RegExp(`${CRON_BLOCK_BEGIN}[\\s\\S]*?${CRON_BLOCK_END}\\n?`, 'g'), '')
    .trim();
  const next = [cleaned, cronBlock].filter(Boolean).join('\n\n') + '\n';

  const install = spawnSync('crontab', ['-'], {
    input: next,
    encoding: 'utf-8',
  });

  if (install.error || install.status !== 0) {
    return {
      attempted: true,
      installed: false,
      message: `crontab 写入失败：${install.error?.message ?? install.stderr?.trim() ?? 'unknown error'}`,
    };
  }

  return {
    attempted: true,
    installed: true,
    message: '已检测到 OpenClaw 环境，KIVO governance cron 已写入 crontab。',
  };
}
