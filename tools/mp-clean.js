/**
 * 清理冒烟测试留下的数据（【冒烟测试】前缀的协同事项及其回复）
 *
 * ✅ 服务运行中也可以执行（换用原生 SQLite + WAL 后，多进程访问由数据库自身加锁协调，
 *    另一进程的写入对运行中的服务立即可见；已由 tools/_dsh_check_livewrite.js 实测验证）。
 *    换驱动前必须先停服务：sql.js 是内存态，运行中改文件会被服务端下一次 db.save() 覆盖。
 *
 * 用法：node tools/mp-clean.js
 */
const db = require('../lib/db');

(async () => {
  await db.init();
  const rows = db.queryAll("SELECT id, issue_no, title, status FROM collab_issues WHERE title LIKE '【冒烟测试】%'");
  if (!rows.length) {
    console.log('✅ 没有需要清理的测试数据');
    db.close();
    return;
  }
  for (const r of rows) {
    db.run('DELETE FROM collab_replies WHERE issue_id=?', [r.id]);
    db.run('DELETE FROM collab_issues WHERE id=?', [r.id]);
    console.log(`  🗑  已删除 ${r.issue_no} [${r.status}] ${r.title}`);
  }
  db.save();
  const left = db.queryOne("SELECT COUNT(*) cnt FROM collab_issues WHERE title LIKE '【冒烟测试】%'").cnt;
  console.log(`✅ 清理完成，剩余 ${left} 条`);
  db.close();
})();
