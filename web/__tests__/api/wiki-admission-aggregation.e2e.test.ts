import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const BASE = 'http://localhost:3000';
let tmpRoot = '';
let dbPath = '';

function makeRequest(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(new URL(path, BASE), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kivo-wiki-e2e-'));
  dbPath = join(tmpRoot, 'kivo.db');
  process.env.KIVO_DB_PATH = dbPath;
});

afterEach(() => {
  delete process.env.KIVO_DB_PATH;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('FR-P05/FR-P06 wiki admission + aggregation e2e', () => {
  it('adopted research report auto-generates wiki page and aggregate API returns versions + links', async () => {
    const researchDb = await import('../../lib/research-db');
    const dashboard = await researchDb.createResearchTask({
      query: '概率论调研',
      topic: '概率论',
      scope: '数学',
      priority: 'high',
      requestedBy: 'e2e-test',
      budgetCredits: 36,
      expectedTypes: ['fact', 'methodology'],
      autoExecute: false,
    });
    const taskId = dashboard.tasks[0].id;

    const reportDir = join(tmpRoot, 'reports');
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, 'probability-research.md');
    writeFileSync(reportPath, [
      '# 概率论',
      '',
      '## 结论',
      '概率论同主题知识可以被聚合成领域笔记，调研报告和材料页面会共享同一 slug。',
      '',
      '## 关键发现',
      '条件概率、全概率公式和贝叶斯公式是高频核心概念。',
      '',
      '## 来源',
      '- 数学材料',
    ].join('\n'), 'utf8');
    researchDb.updateResearchTaskStatusForTest(taskId, 'completed', reportPath);

    const adoptRoute = await import('../../app/api/v1/research/[id]/adopt/route');
    const adoptRes = await adoptRoute.POST(makeRequest(`/api/v1/research/${taskId}/adopt`, 'POST'), { params: Promise.resolve({ id: taskId }) });
    expect(adoptRes.status).toBe(200);

    const detail = researchDb.getResearchTaskDetail(taskId);
    expect(detail?.wikiPageId).toBeTruthy();

    const wikiRepoMod = await import('../../lib/wiki-engine');
    const repo = wikiRepoMod.getWikiRepository();
    const basePage = repo.findById(detail!.wikiPageId!);
    expect(basePage?.metadata.extra?.aggregateSlug).toBeTruthy();
    const slug = String(basePage?.metadata.extra?.aggregateSlug ?? '');

    repo.createPage({
      title: '概率论材料',
      parentId: repo.listSpaces()[0].id,
      summary: '材料侧知识',
      content: '条件概率题型整理与贝叶斯公式例题。',
      tags: [slug],
      metadata: {
        source: {
          type: 'document',
          uri: 'materials://probability',
          collectedAt: new Date().toISOString(),
        },
        extra: {
          aggregateSlug: slug,
          knowledgeType: 'material_note',
        },
      },
    });

    const aggregateRoute = await import('../../app/api/v1/wiki/pages/aggregate/route');
    const aggregateRes = await aggregateRoute.POST(makeRequest('/api/v1/wiki/pages/aggregate', 'POST', { slug, title: '概率论', space: 'default-space' }));
    expect(aggregateRes.status).toBe(200);

    const pageRoute = await import('../../app/api/v1/wiki/pages/[slug]/route');
    const pageRes = await pageRoute.GET(makeRequest(`/api/v1/wiki/pages/${slug}?space=default-space`), { params: Promise.resolve({ slug }) });
    expect(pageRes.status).toBe(200);
    const pageBody = await json<{ data: { title: string; versions: unknown[]; links: unknown[]; sourcePages: unknown[] } }>(pageRes);
    expect(pageBody.data.title).toContain('概率论');
    expect(pageBody.data.versions.length).toBeGreaterThan(0);
    expect(pageBody.data.links.length).toBeGreaterThan(0);
    expect(pageBody.data.sourcePages.length).toBeGreaterThan(0);

    const db = new Database(dbPath);
    try {
      const wikiPages = (db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE type = 'wiki_page'`).get() as { c: number }).c;
      const versions = (db.prepare(`SELECT COUNT(*) AS c FROM wiki_page_versions`).get() as { c: number }).c;
      const links = (db.prepare(`SELECT COUNT(*) AS c FROM wiki_links`).get() as { c: number }).c;
      expect(wikiPages).toBeGreaterThan(0);
      expect(versions).toBeGreaterThan(0);
      expect(links).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  }, 15000);
});
