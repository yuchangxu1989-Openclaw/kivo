import Database from 'better-sqlite3';
const db = new Database('/root/.openclaw/workspace/projects/kivo/kivo.db');

// 统计前
const before = db.prepare("SELECT type, count(*) as cnt FROM entries GROUP BY type").all();
console.log("BEFORE:", before);

// 删完全重复（保留最新）
const dupResult = db.prepare("DELETE FROM entries WHERE id NOT IN (SELECT MAX(id) FROM entries GROUP BY content, type)").run();
console.log("Deleted duplicates:", dupResult.changes);

// 删过短条目（meta 除外）
const shortResult = db.prepare("DELETE FROM entries WHERE length(content) < 20 AND type != 'meta'").run();
console.log("Deleted short entries:", shortResult.changes);

// 重建 FTS
db.prepare("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')").run();

// 统计后
const after = db.prepare("SELECT type, count(*) as cnt FROM entries GROUP BY type").all();
console.log("AFTER:", after);

// 验证无重复
const remaining = db.prepare("SELECT content, type, count(*) as cnt FROM entries GROUP BY content, type HAVING cnt > 1").all();
console.log("Remaining duplicates:", remaining.length === 0 ? "NONE ✓" : remaining);

db.close();
