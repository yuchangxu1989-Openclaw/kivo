import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const CRON_BLOCK_BEGIN = '# >>> KIVO automation >>>';
const CRON_BLOCK_END = '# <<< KIVO automation <<<' ;
const DEFAULT_GOVERNANCE_SCHEDULE = '0 3 * * *';
const DEFAULT_WATCH_INTERVAL_MS = 15_000;

export interface AutomationCommands {
  governanceCommand: string;
  watcherCommand: string;
  cronLines: string[];
  watchDir: string;
  stateFile: string;
}

export interface CrontabInstallResult {
  attempted: boolean;
  installed: boolean;
  message: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function getDefaultBadcaseWatchDir(cwd: string = process.cwd()): string {
  const openclawHome = process.env.OPENCLAW_HOME;
  if (openclawHome) {
    return resolve(openclawHome, 'workspace', 'logs');
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
  const governanceLog = resolve(logDir, 'auto-govern.log');
  const watcherLog = resolve(logDir, 'watch-badcases.log');

  const governanceCommand = 'kivo auto-govern';
  const watcherCommand = `kivo watch-badcases --dir ${shellQuote(watchDir)}`;

  const cronLines = [
    `${DEFAULT_GOVERNANCE_SCHEDULE} sh -lc ${shellQuote(`cd ${shellQuote(dir)} && mkdir -p ${shellQuote(logDir)} && npx kivo auto-govern >> ${shellQuote(governanceLog)} 2>&1`)}`,
    `@reboot sh -lc ${shellQuote(`cd ${shellQuote(dir)} && mkdir -p ${shellQuote(logDir)} && nohup npx kivo watch-badcases --dir ${shellQuote(watchDir)} --state-file ${shellQuote(stateFile)} --interval ${DEFAULT_WATCH_INTERVAL_MS} >> ${shellQuote(watcherLog)} 2>&1 &`)}`,
  ];

  return {
    governanceCommand,
    watcherCommand,
    cronLines,
    watchDir,
    stateFile,
  };
}

export function installAutomationCrontab(cwd: string = process.cwd()): CrontabInstallResult {
  const openclawHome = process.env.OPENCLAW_HOME;
  if (!openclawHome) {
    return {
      attempted: false,
      installed: false,
      message: 'OPENCLAW_HOME 未设置，跳过自动写入 crontab。',
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
    message: '已检测到 OpenClaw 环境，自动治理与 badcase 监听已写入 crontab。',
  };
}
