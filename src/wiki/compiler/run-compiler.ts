/**
 * FR-P06: Wiki Page Compiler CLI entry point.
 *
 * Usage:
 *   npx tsx src/wiki/compiler/run-compiler.ts [--subject <id>] [--db <path>]
 *
 * Compiles wiki pages from atomic entries grouped by subject_id.
 * Hermes (OpenClaw ACP Agent) / 2026-05-24
 */

import { WikiPageCompiler } from './wiki-page-compiler.js';
import { resolve } from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  const dbPath = getArg(args, '--db') ?? resolve(process.cwd(), 'kivo.db');
  const subjectId = getArg(args, '--subject');

  console.log(`[wiki-compiler] DB: ${dbPath}`);
  console.log(`[wiki-compiler] Subject: ${subjectId ?? 'ALL'}`);

  const compiler = new WikiPageCompiler(dbPath);

  try {
    if (subjectId) {
      const page = await compiler.compileForSubject(subjectId);
      console.log(`[wiki-compiler] Compiled page: ${page.title}`);
      console.log(`[wiki-compiler]   pageId: ${page.pageId}`);
      console.log(`[wiki-compiler]   sections: ${page.sectionsJson.length}`);
      console.log(`[wiki-compiler]   entries: ${page.entryIds.length}`);
      console.log(`[wiki-compiler]   links: ${page.links.length}`);
    } else {
      const result = await compiler.compileAll();
      console.log(`[wiki-compiler] Done.`);
      console.log(`[wiki-compiler]   pages created: ${result.pagesCreated}`);
      console.log(`[wiki-compiler]   links created: ${result.linksCreated}`);
      if (result.errors.length > 0) {
        console.error(`[wiki-compiler]   errors: ${result.errors.length}`);
        for (const err of result.errors) {
          console.error(`    - ${err}`);
        }
      }
    }
  } finally {
    compiler.close();
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main().catch((err) => {
  console.error(`[wiki-compiler] FATAL: ${(err as Error).message}`);
  process.exit(1);
});
