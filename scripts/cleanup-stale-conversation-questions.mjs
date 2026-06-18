/**
 * 一次性清理：删除开发期（疑问句过滤上线前）误沉淀的「对话疑问句」记忆。
 * 现行代码不再沉淀疑问句，但持久化 DB 里残留的旧问句记忆需手动清掉，保持人格记忆干净。
 *
 * 仅删除：kind=episodic 且 content 以「（来自对话）」开头、且正文是疑问句（含 吗/呢/什么/怎么/
 * 为什么/如何/多少/哪/谁/？等）的记忆。陈述类对话记忆（如「叫张三」）保留。
 *
 * 跑法：CHRONO_DB_PATH=... node scripts/cleanup-stale-conversation-questions.mjs
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.CHRONO_DB_PATH;
if (!DB_PATH) { console.error('需要 CHRONO_DB_PATH'); process.exit(1); }

const PREFIX = '（来自对话）';
const QUESTION = /[?？吗呢]|什么|怎么|怎样|为什么|为何|如何|多少|哪里|哪儿|哪个|哪|谁|几时|几点/;

const db = new Database(DB_PATH);
/* memory_nodes 表（kernel core-self）：列 id, kind, content。 */
const rows = db.prepare("SELECT id, content FROM memory_nodes WHERE kind = 'episodic'").all();
const stale = rows.filter((r) => typeof r.content === 'string'
  && r.content.startsWith(PREFIX)
  && QUESTION.test(r.content.slice(PREFIX.length)));

if (stale.length === 0) { console.log('无残留疑问句对话记忆，无需清理。'); process.exit(0); }

console.log(`将删除 ${stale.length} 条残留疑问句对话记忆：`);
for (const r of stale) console.log('  ·', r.content);

const del = db.prepare('DELETE FROM memory_nodes WHERE id = ?');
const tx = db.transaction((ids) => { for (const id of ids) del.run(id); });
tx(stale.map((r) => r.id));
console.log(`✓ 已删除 ${stale.length} 条。`);
db.close();
