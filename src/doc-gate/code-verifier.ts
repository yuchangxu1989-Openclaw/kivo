import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocReference, Mismatch, ScanResult, DocGateOptions } from './types.js';
import { scanDocsDir } from './doc-scanner.js';

export function verifyDocCodeConsistency(options: DocGateOptions): ScanResult {
  const { docsDir, srcDir, exportFile } = options;
  const { refs, files } = scanDocsDir(docsDir);
  const exports = collectExports(srcDir, exportFile);
  const mismatches: Mismatch[] = [];

  for (const ref of refs) {
    if (ref.kind === 'api') {
      const baseName = ref.name.split('.').pop()!;
      if (!exports.has(baseName) && !exports.has(ref.name)) {
        mismatches.push({
          reference: ref,
          reason: 'missing-in-code',
          detail: `API "${ref.name}" referenced in docs but not found in exports`,
        });
      }
    } else if (ref.kind === 'error-code') {
      if (!exports.has(ref.name) && !findInSource(srcDir, ref.name)) {
        mismatches.push({
          reference: ref,
          reason: 'missing-in-code',
          detail: `Error code "${ref.name}" referenced in docs but not found in source`,
        });
      }
    } else if (ref.kind === 'config') {
      const leafKey = ref.name.split('.').pop()!;
      if (!findInSource(srcDir, leafKey)) {
        mismatches.push({
          reference: ref,
          reason: 'missing-in-code',
          detail: `Config key "${ref.name}" referenced in docs but not found in source`,
        });
      }
    } else if (ref.kind === 'code-block') {
      const parseErr = checkCodeBlockSyntax(ref.name);
      if (parseErr) {
        mismatches.push({
          reference: ref,
          reason: 'example-parse-error',
          detail: parseErr,
        });
      }
    }
  }

  return { references: refs, mismatches, scannedFiles: files };
}
function collectExports(srcDir: string, exportFile?: string): Set<string> {
  const names = new Set<string>();
  const target = exportFile ? resolve(exportFile) : resolve(srcDir, 'index.ts');
  if (!existsSync(target)) return names;
  const content = readFileSync(target, 'utf-8');
  const exportRe = /export\s+(?:(?:type\s+)?{([^}]+)}|(?:function|class|const|type|interface|enum)\s+([\w]+))/g;
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(content)) !== null) {
    if (m[1]) {
      for (const part of m[1].split(',')) {
        const name = part.replace(/\s+as\s+\w+/, '').trim();
        if (name) names.add(name);
      }
    }
    if (m[2]) names.add(m[2]);
  }
  const reExportRe = /export\s+\*\s+from/g;
  if (reExportRe.test(content)) {
    collectSourceSymbols(srcDir, names);
  }
  return names;
}

function collectSourceSymbols(dir: string, out: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
      collectSourceSymbols(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      const src = readFileSync(full, 'utf-8');
      const expRe = /export\s+(?:function|class|const|type|interface|enum)\s+([\w]+)/g;
      let em: RegExpExecArray | null;
      while ((em = expRe.exec(src)) !== null) {
        out.add(em[1]);
      }
    }
  }
}

function findInSource(srcDir: string, token: string): boolean {
  if (!existsSync(srcDir)) return false;
  for (const entry of readdirSync(srcDir)) {
    const full = resolve(srcDir, entry);
    const st = statSync(full);
    if (st.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules') {
      if (findInSource(full, token)) return true;
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      const content = readFileSync(full, 'utf-8');
      if (content.includes(token)) return true;
    }
  }
  return false;
}

function checkCodeBlockSyntax(code: string): string | null {
  const opens = (code.match(/[({[]/g) || []).length;
  const closes = (code.match(/[)}\]]/g) || []).length;
  if (opens !== closes) {
    return `Unbalanced brackets: ${opens} opening vs ${closes} closing`;
  }
  if (/import\s+.*from\s+['"][^'"]*['"]/.test(code)) {
    const imports = code.match(/from\s+['"]([^'"]+)['"]/g) || [];
    for (const imp of imports) {
      const mod = imp.replace(/from\s+['"]/, '').replace(/['"]/, '');
      if (mod.startsWith('.') || mod.startsWith('/')) continue;
      if (mod === 'kivo' || mod.startsWith('kivo/') || mod.startsWith('@')) continue;
      return `Unknown module reference: ${mod}`;
    }
  }
  return null;
}
