'use strict';
const initSqlJs = require('sql.js'), fs=require('fs');
module.exports = async function fixture(file) {
  const SQL=await initSqlJs(), raw=new SQL.Database(file&&fs.existsSync(file)?fs.readFileSync(file):undefined);
  const db={
    queryAll(sql,params=[]){const stmt=raw.prepare(sql);try{stmt.bind(params);const rows=[];while(stmt.step())rows.push(stmt.getAsObject());return rows}finally{stmt.free()}},
    queryOne(sql,params=[]){return this.queryAll(sql,params)[0]||null},
    run(sql,params=[]){raw.run(sql,params)},
    insert(sql,params=[]){raw.run(sql,params);return this.queryOne('SELECT last_insert_rowid() AS id').id},
    save(){if(file)fs.writeFileSync(file,Buffer.from(raw.export()))},
  };
  db.run('CREATE TABLE IF NOT EXISTS stores(id INTEGER PRIMARY KEY,store_name TEXT NOT NULL)');
  db.run("INSERT OR IGNORE INTO stores VALUES(1,'方州店（本地测试）'),(2,'测试二店')");
  require('../lib/store-tasks').ensureSchema(db);
  return {db,raw};
};
