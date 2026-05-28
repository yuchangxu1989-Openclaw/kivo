/**
 * FR-P06 Wiki 页面编译 CLI
 *
 * 用法：
 *   npx tsx scripts/run-wiki-compiler.ts [--db ./kivo.db] [--subject <subject_node_id>]
 *
 * Codex (OpenClaw ACP Agent) / 2026-05-24
 */

import { resolve } from 'node:path';

import { WikiPageCompiler } from '../src/wiki/compiler/wiki-page-compiler.js';

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = resolve(process.cwd(), getArg(args, '--db') ?? 'kivo.db');
  const subjectId = getArg(args, '--subject');

  const compiler = new WikiPageCompiler(dbPath);

  try {
    if (subjectId) {
      compiler.ensureCompiledPageShells([subjectId]);
      const page = await compiler.compileForSubject(subjectId);
      console.log(JSON.stringify({
        subjectId,
        pageId: page.pageId,
        title: page.title,
        entryCount: page.entryIds.length,
        materialCount: page.materialIds.length,
        linkCount: page.links.length,
      }, null, 2));
      return;
    }

    const subjectIds = compiler.listActiveSubjectIds();
    const result = await compiler.compileSubjects(subjectIds);
    console.log(JSON.stringify({
      subjectCount: subjectIds.length,
      pagesCreated: result.pagesCreated,
      pagesUpdated: result.pagesUpdated,
      linksCreated: result.linksCreated,
      errors: result.errors,
      items: result.items,
    }, null, 2));
  } finally {
    compiler.close();
  }
}

main().catch((error) => {
  console.error(`[wiki-compiler] FATAL: ${(error as Error).message}`);
  process.exit(1);
});
