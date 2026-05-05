import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { DocReference, ReferenceKind } from './types.js';

const API_PATTERN = /`([\w]+(?:\.[\w]+)*)\s*\(/g;
const CONFIG_KEY_PATTERN = /`([\w]+(?:\.[\w]+)+)`/g;
const ERROR_CODE_PATTERN = /`(ERR_[\w]+)`/g;
const CODE_BLOCK_PATTERN = /```(?:ts|typescript|js|javascript)\n([\s\S]*?)```/g;

export function scanMarkdownFile(filePath: string): DocReference[] {
  const content = readFileSync(filePath, 'utf-8');
  const refs: DocReference[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(API_PATTERN)) {
      refs.push({ kind: 'api', name: m[1], file: filePath, line: i + 1 });
    }
    for (const m of line.matchAll(ERROR_CODE_PATTERN)) {
      refs.push({ kind: 'error-code', name: m[1], file: filePath, line: i + 1 });
    }
    for (const m of line.matchAll(CONFIG_KEY_PATTERN)) {
      if (!m[1].startsWith('ERR_')) {
        refs.push({ kind: 'config', name: m[1], file: filePath, line: i + 1 });
      }
    }
  }

  let blockMatch: RegExpExecArray | null;
  const blockRe = new RegExp(CODE_BLOCK_PATTERN.source, 'g');
  while ((blockMatch = blockRe.exec(content)) !== null) {
    const blockStart = content.slice(0, blockMatch.index).split('\n').length;
    refs.push({ kind: 'code-block', name: blockMatch[1].trim(), file: filePath, line: blockStart });
  }

  return refs;
}

export function scanDocsDir(docsDir: string, patterns: string[] = ['**/*.md']): { refs: DocReference[]; files: string[] } {
  const files: string[] = [];
  for (const pattern of patterns) {
    const found = findMarkdownFiles(docsDir, pattern);
    files.push(...found);
  }
  const refs: DocReference[] = [];
  for (const f of files) {
    refs.push(...scanMarkdownFile(f));
  }
  return { refs, files };
}

function findMarkdownFiles(dir: string, _pattern: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  collectMd(dir, results);
  return results;
}

function collectMd(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
      collectMd(full, out);
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
}
