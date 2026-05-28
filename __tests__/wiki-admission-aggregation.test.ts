import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { WikiRepository } from '../src/wiki/db/wiki-repository.js';
import { SpaceManager } from '../src/wiki/organization/space-manager.js';
import { WikiAdmissionPipeline } from '../src/wiki/admission-pipeline.js';
import { WikiAggregationEngine } from '../src/wiki/aggregation-engine.js';

describe('WikiAdmissionPipeline + WikiAggregationEngine', () => {
  it('admits an adopted report, persists artifact rows, and aggregates into one wiki page', async () => {
    const db = new Database(':memory:');
    const repo = new WikiRepository({ db });
    const space = new SpaceManager(repo).ensureDefaultSpace();

    const admission = new WikiAdmissionPipeline({ repository: repo });
    const first = await admission.admitResearchReport({
      taskId: 'research-1',
      title: '概率论',
      reportPath: 'reports/probability-1.md',
      report: [
        '# 概率论',
        '',
        '## 结论',
        '概率论学习要先把随机事件、条件概率与贝叶斯公式串起来，才能稳定迁移到后续题型。',
        '',
        '## 关键发现',
        '教材题和真题共享同一组概念骨架：事件、样本空间、全概率、条件独立。解题时先定义事件，再判断独立性和条件关系，可以明显减少列式错误。',
        '',
        '## 方法建议',
        '复习顺序建议从事件运算、古典概型、条件概率、全概率公式推进到贝叶斯公式，每一节都配一组真题和错题反思，这样聚合后的 wiki 页面能同时保留结论、方法和例题入口。',
        '',
        '## 来源',
        '- 课本章节',
        '- 习题整理',
      ].join('\n'),
      expectedTypes: ['fact', 'methodology'],
      spaceId: space.id,
    });

    const second = await admission.admitResearchReport({
      taskId: 'research-2',
      title: '概率论',
      reportPath: 'reports/probability-2.md',
      report: [
        '# 概率论',
        '',
        '## 结论',
        '解题时最容易失分的是没有把题目翻译成事件关系，因此需要先画事件树再列式。',
        '',
        '## 关键发现',
        '同主题材料页面经常补充例题和误区，适合跟 adopted 报告一起聚合。聚合页应该把调研结论、例题入口和历史版本放在一个 URL 下，方便学生持续回看。',
        '',
        '## 方法建议',
        '对于二项分布和条件概率混合题，先列样本空间，再标记条件过滤，最后再套用公式，能够减少直接套公式导致的错误。',
        '',
        '## 来源',
        '- 课堂讲义',
      ].join('\n'),
      expectedTypes: ['experience'],
      spaceId: space.id,
    });

    repo.createPage({
      title: '概率论例题',
      parentId: space.id,
      summary: '材料提炼出的同主题例题页面',
      content: '条件概率例题、全概率例题和贝叶斯例题。',
      tags: [first.slug],
      metadata: {
        source: {
          type: 'document',
          uri: 'materials://probability-book',
          collectedAt: new Date().toISOString(),
        },
        extra: {
          aggregateSlug: first.slug,
          knowledgeType: 'material_note',
        },
      },
    });

    expect(['admitted', 'pending_confirm']).toContain(first.admissionState);
    expect(second.page.metadata.extra?.aggregateSlug).toBe(first.slug);

    const aggregation = new WikiAggregationEngine({ repository: repo }).aggregate({
      slug: first.slug,
      title: '概率论',
      spaceId: space.id,
    });

    expect(aggregation.page.metadata.extra?.aggregateRole).toBe('aggregate');
    expect(aggregation.sources.length).toBe(3);
    expect(aggregation.page.content).toContain('来源溯源');

    const wikiPages = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE type = 'wiki_page'`).get() as { c: number };
    const versions = db.prepare(`SELECT COUNT(*) AS c FROM wiki_page_versions`).get() as { c: number };
    const links = db.prepare(`SELECT COUNT(*) AS c FROM wiki_links`).get() as { c: number };
    const artifacts = db.prepare(`SELECT COUNT(*) AS c FROM analysis_artifacts`).get() as { c: number };

    expect(wikiPages.c).toBeGreaterThan(0);
    expect(versions.c).toBeGreaterThan(0);
    expect(links.c).toBeGreaterThan(0);
    expect(artifacts.c).toBeGreaterThan(0);
  });
});
