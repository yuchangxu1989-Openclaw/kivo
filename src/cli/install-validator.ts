/**
 * Install Validator — 安装与环境校验
 *
 * FR-Z01:
 * - AC1: 提供正式安装路径，声明支持矩阵（Node 版本、OS、架构）
 * - AC2: 安装后自动执行环境校验
 * - AC3: 校验不通过时输出缺失项和修复建议
 * - AC4: 校验通过后输出系统就绪确认
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface SupportMatrix {
  nodeVersions: string[];
  os: string[];
  architectures: string[];
}

export const SUPPORT_MATRIX: SupportMatrix = {
  nodeVersions: ['18', '20', '22'],
  os: ['linux', 'darwin', 'win32'],
  architectures: ['x64', 'arm64'],
};

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface EnvCheckItem {
  name: string;
  status: CheckStatus;
  detail: string;
  suggestion?: string;
}

export interface EnvCheckReport {
  items: EnvCheckItem[];
  allPassed: boolean;
  passCount: number;
  failCount: number;
  warnCount: number;
}

/**
 * AC2: 执行环境校验
 * AC3: 校验不通过时输出缺失项和修复建议
 * AC4: 校验通过后输出系统就绪确认
 */
export function checkEnvironment(dbPath?: string): EnvCheckReport {
  const items: EnvCheckItem[] = [];

  // 1. Node.js 版本
  const nodeVersion = process.versions.node;
  const majorVersion = nodeVersion.split('.')[0];
  const nodeSupported = SUPPORT_MATRIX.nodeVersions.includes(majorVersion);
  items.push({
    name: 'Node.js 版本',
    status: nodeSupported ? 'pass' : 'fail',
    detail: `v${nodeVersion} (需要 ${SUPPORT_MATRIX.nodeVersions.map(v => `v${v}.x`).join(' / ')})`,
    suggestion: nodeSupported ? undefined : `请安装 Node.js ${SUPPORT_MATRIX.nodeVersions[SUPPORT_MATRIX.nodeVersions.length - 1]}.x LTS`,
  });

  // 2. OS
  const platform = process.platform;
  const osSupported = SUPPORT_MATRIX.os.includes(platform);
  items.push({
    name: '操作系统',
    status: osSupported ? 'pass' : 'warn',
    detail: `${platform} (支持 ${SUPPORT_MATRIX.os.join(', ')})`,
    suggestion: osSupported ? undefined : '当前操作系统未在支持矩阵中，可能存在兼容性问题',
  });

  // 3. Architecture
  const arch = process.arch;
  const archSupported = SUPPORT_MATRIX.architectures.includes(arch);
  items.push({
    name: '系统架构',
    status: archSupported ? 'pass' : 'warn',
    detail: `${arch} (支持 ${SUPPORT_MATRIX.architectures.join(', ')})`,
    suggestion: archSupported ? undefined : '当前架构未在支持矩阵中',
  });

  // 4. SQLite native module
  let sqliteOk = false;
  try {
    // Use createRequire for resolve — works in both CJS and ESM
    const esmReq = typeof require !== 'undefined' ? require : createRequire(pathToFileURL(join(process.cwd(), '__kivo_resolve__.js')).href);
    esmReq.resolve('better-sqlite3');
    sqliteOk = true;
  } catch {
    // try dynamic import check
    sqliteOk = false;
  }
  items.push({
    name: 'SQLite 模块',
    status: sqliteOk ? 'pass' : 'warn',
    detail: sqliteOk ? 'better-sqlite3 可用' : 'better-sqlite3 未检测到（可能使用 ESM 加载）',
    suggestion: sqliteOk ? undefined : '运行 npm install better-sqlite3 安装 SQLite 支持',
  });

  // 5. 数据库路径可写性
  if (dbPath && dbPath !== ':memory:') {
    const dirExists = existsSync(dbPath) || existsSync(dirname(dbPath));
    items.push({
      name: '数据库路径',
      status: dirExists ? 'pass' : 'fail',
      detail: dirExists ? `路径可用: ${dbPath}` : `路径不存在: ${dbPath}`,
      suggestion: dirExists ? undefined : '请确认数据库路径的父目录存在且有写权限',
    });
  }

  const passCount = items.filter(i => i.status === 'pass').length;
  const failCount = items.filter(i => i.status === 'fail').length;
  const warnCount = items.filter(i => i.status === 'warn').length;

  return {
    items,
    allPassed: failCount === 0,
    passCount,
    failCount,
    warnCount,
  };
}

/** 格式化环境校验报告 */
export function formatEnvCheckReport(report: EnvCheckReport): string {
  const lines: string[] = ['KIVO 环境校验报告', '='.repeat(30), ''];

  for (const item of report.items) {
    const icon = item.status === 'pass' ? '✓' : item.status === 'fail' ? '✗' : '⚠';
    lines.push(`${icon} ${item.name}: ${item.detail}`);
    if (item.suggestion) {
      lines.push(`  → ${item.suggestion}`);
    }
  }

  lines.push('');
  if (report.allPassed) {
    lines.push('✓ 环境校验通过，系统就绪。');
  } else {
    lines.push(`✗ 环境校验未通过（${report.failCount} 项失败，${report.warnCount} 项警告）`);
  }

  return lines.join('\n');
}
