#!/usr/bin/env node
const path = require('path');
const Database = require('../node_modules/better-sqlite3');

const dbPath = process.env.KIVO_DB_PATH || path.resolve(__dirname, '../kivo.db');
const db = new Database(dbPath);

const spaceId = 'wiki-space-probstat';
const now = () => new Date().toISOString();
const chapters = [
  ['kivo-wiki-probstat-dir-01', '导论', [1]],
  ['kivo-wiki-probstat-dir-02', '第一章 随机事件与概率', [2, 11, 12, 13, 14, 15, 16, 17, 18]],
  ['kivo-wiki-probstat-dir-03', '第二章 一维随机变量及分布', [3, 19, 20, 21, 22, 23, 24, 25, 26, 27]],
  ['kivo-wiki-probstat-dir-04', '第三章 多维随机变量及分布', [4, 28, 29, 30, 31, 32, 33, 34, 35]],
  ['kivo-wiki-probstat-dir-05', '第四章 随机变量数字特征', [5, 36, 37, 38, 39, 40, 41, 42]],
  ['kivo-wiki-probstat-dir-06', '第五章 大数定律与中心极限定理', [6, 43, 44, 45, 46, 47, 48]],
  ['kivo-wiki-probstat-dir-07', '第六章 统计量与抽样分布', [7, 49, 50, 51, 52, 53, 54]],
  ['kivo-wiki-probstat-dir-08', '第七章 参数估计', [8, 55, 56, 57, 61]],
  ['kivo-wiki-probstat-dir-09', '第八章 区间估计与假设检验', [9, 58, 59, 60, 62, 63, 64, 65, 66, 67, 68]],
  ['kivo-wiki-probstat-dir-10', '综合与考试重点', [10, 69, 70]],
];

const upsertDir = db.prepare(`
  INSERT INTO entries (
    id, type, title, content, summary, source_json, confidence, status, tags_json, domain,
    created_at, updated_at, version, nature, function_tag, knowledge_domain, metadata_json,
    origin_role, parent_id, sort_order
  ) VALUES (?, 'wiki_directory', ?, '', ?, '{}', 0.9, 'active', '[]', '概率论与数理统计',
    ?, ?, 1, 'fact', 'reference', '概率论与数理统计', '{}', 'dev-02', ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    summary = excluded.summary,
    status = 'active',
    deleted_at = NULL,
    parent_id = excluded.parent_id,
    sort_order = excluded.sort_order,
    updated_at = excluded.updated_at
`);
const movePage = db.prepare(`
  UPDATE entries SET parent_id = ?, sort_order = ?, updated_at = datetime('now')
  WHERE id = ? AND type = 'wiki_page'
`);

const tx = db.transaction(() => {
  chapters.forEach(([dirId, title, pageNums], dirIndex) => {
    const ts = now();
    upsertDir.run(dirId, title, `${title} 的知识点目录`, ts, ts, spaceId, dirIndex + 1);
    pageNums.forEach((num, pageIndex) => {
      movePage.run(dirId, pageIndex + 1, `kivo-wiki-probstat-${String(num).padStart(2, '0')}`);
    });
  });
});

tx();
console.log('probstat wiki directories normalized');
console.log(db.prepare("SELECT type, parent_id, COUNT(*) AS cnt FROM entries WHERE type IN ('wiki_directory','wiki_page') GROUP BY type,parent_id ORDER BY type,parent_id").all());
db.close();
